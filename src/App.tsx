import React, { useState, useRef, useEffect } from 'react';
import { Mic, Loader2, Volume2, Sparkles, Power, MessageSquareText, X, Heart } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { Message } from './types';

function pcmToBase64(pcmData: Float32Array): string {
  const buffer = new ArrayBuffer(pcmData.length * 2);
  const view = new DataView(buffer);
  for (let i = 0; i < pcmData.length; i++) {
    let s = Math.max(-1, Math.min(1, pcmData[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export default function App() {
  const [appState, setAppState] = useState<'idle' | 'listening' | 'speaking'>('idle');
  const [isActive, setIsActive] = useState(false);
  const [messages, setMessages] = useState<Message[]>(() => {
    try {
      const saved = localStorage.getItem('mayra_history');
      if (saved) return JSON.parse(saved);
    } catch (e) {
      console.warn('Failed to load history', e);
    }
    return [];
  });
  const [showTranscript, setShowTranscript] = useState(false);
  
  const wsRef = useRef<WebSocket | null>(null);
  const inputAudioCtxRef = useRef<AudioContext | null>(null);
  const outputAudioCtxRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const nextStartTimeRef = useRef<number>(0);
  const wakeLockRef = useRef<any>(null);
  
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const intendedActiveRef = useRef(false);
  const reconnectTimeoutRef = useRef<any>(null);

  const requestWakeLock = async () => {
    try {
      if ('wakeLock' in navigator) {
        wakeLockRef.current = await (navigator as any).wakeLock.request('screen');
      }
    } catch (err) {
      console.warn('Wake Lock error:', err);
    }
  };

  const releaseWakeLock = async () => {
    if (wakeLockRef.current) {
      try {
        await wakeLockRef.current.release();
        wakeLockRef.current = null;
      } catch (err) {
        console.warn('Wake Lock release error:', err);
      }
    }
  };

  useEffect(() => {
    localStorage.setItem('mayra_history', JSON.stringify(messages));
  }, [messages]);

  // Try to keep audio context alive and screen awake when tab returns to foreground
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible' && intendedActiveRef.current) {
        requestWakeLock();
        if (inputAudioCtxRef.current?.state === 'suspended') {
          inputAudioCtxRef.current.resume();
        }
        if (outputAudioCtxRef.current?.state === 'suspended') {
          outputAudioCtxRef.current.resume();
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, []);

  useEffect(() => {
    if (showTranscript) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, showTranscript]);

  const playAudioChunk = (base64: string) => {
    if (!outputAudioCtxRef.current) return;
    const audioCtx = outputAudioCtxRef.current;
    
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const buffer = bytes.buffer;
    
    const numSamples = buffer.byteLength / 2;
    const audioBuffer = audioCtx.createBuffer(1, numSamples, 24000);
    const channelData = audioBuffer.getChannelData(0);
    const dataView = new DataView(buffer);
    
    for (let i = 0; i < numSamples; i++) {
      channelData[i] = dataView.getInt16(i * 2, true) / 0x8000;
    }
    
    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);
    
    const currentTime = audioCtx.currentTime;
    if (nextStartTimeRef.current < currentTime) {
      nextStartTimeRef.current = currentTime;
    }
    
    source.start(nextStartTimeRef.current);
    nextStartTimeRef.current += audioBuffer.duration;
  };

  const startSession = async () => {
    intendedActiveRef.current = true;
    requestWakeLock();
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    
    setIsActive(true);
    setAppState('listening');
    
    try {
      const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${location.host}/live`;
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        // Send previous context up to last 20 messages for persistence
        const historyContext = messages.slice(-20);
        ws.send(JSON.stringify({ type: 'init', history: historyContext }));
      };

      const inputAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      const outputAudioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      inputAudioCtxRef.current = inputAudioCtx;
      outputAudioCtxRef.current = outputAudioCtx;
      nextStartTimeRef.current = 0;

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: { facingMode: 'user' } });
      } catch (err) {
        console.warn("Camera permission denied or not available. Falling back to audio only.", err);
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (audioErr) {
          console.warn("Microphone permission denied", audioErr);
          alert("Microphone permission is required to chat with Mayra. Please allow it in your browser settings or open the app in a new tab.");
          stopSession();
          return;
        }
      }
      mediaStreamRef.current = stream;

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
      }
      
      videoIntervalRef.current = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN && videoRef.current && canvasRef.current) {
          const video = videoRef.current;
          const canvas = canvasRef.current;
          if (video.videoWidth > 0 && video.videoHeight > 0) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const ctx = canvas.getContext('2d');
            if (ctx) {
              ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
              // Get base64 string without data url prefix
              const dataUrl = canvas.toDataURL('image/jpeg', 0.5);
              const base64 = dataUrl.split(',')[1];
              ws.send(JSON.stringify({ video: base64 }));
            }
          }
        }
      }, 1000); // 1 frame per second
      
      const source = inputAudioCtx.createMediaStreamSource(stream);
      const processor = inputAudioCtx.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;
      
      source.connect(processor);
      processor.connect(inputAudioCtx.destination);
      
      processor.onaudioprocess = (e) => {
        if (ws.readyState === WebSocket.OPEN) {
          const base64 = pcmToBase64(e.inputBuffer.getChannelData(0));
          ws.send(JSON.stringify({ audio: base64 }));
        }
      };

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        if (msg.type === 'audio') {
          setAppState('speaking');
          playAudioChunk(msg.audio);
        }
        if (msg.type === 'interrupted') {
           nextStartTimeRef.current = 0; // Reset playback queue
        }
        if (msg.type === 'turnComplete') {
           setAppState('listening');
        }
        if (msg.type === 'open_website') {
           // Open the requested URL in a new tab
           window.open(msg.url, '_blank', 'noopener,noreferrer');
        }
        if (msg.type === 'raw') {
           const { message } = msg;
           
           // Extract model transcription
           const modelParts = message.serverContent?.modelTurn?.parts;
           if (modelParts) {
             const textPart = modelParts.find((p:any) => p.text);
             if (textPart) {
               setMessages(prev => {
                  const last = prev[prev.length - 1];
                  if (last && last.role === 'model') {
                     const updated = [...prev];
                     updated[updated.length - 1] = { ...last, text: last.text + textPart.text };
                     return updated;
                  }
                  return [...prev, { id: Date.now().toString(), role: 'model', text: textPart.text }];
               });
             }
           }

           // Extract user transcription (usually comes in clientContent)
           const clientParts = message.clientContent?.turns?.[0]?.parts || message.clientContent?.turnComplete?.parts;
           if (clientParts) {
             const textPart = clientParts.find((p:any) => p.text);
             if (textPart) {
               setMessages(prev => {
                  const last = prev[prev.length - 1];
                  if (last && last.role === 'user') {
                     const updated = [...prev];
                     updated[updated.length - 1] = { ...last, text: last.text + textPart.text };
                     return updated;
                  }
                  return [...prev, { id: Date.now().toString(), role: 'user', text: textPart.text }];
               });
             }
           }
        }
      };

      ws.onclose = () => {
        cleanupResources();
        if (intendedActiveRef.current) {
          // Auto-reconnect if it closed unexpectedly (e.g., background throttling)
          setAppState('idle');
          reconnectTimeoutRef.current = setTimeout(() => {
            if (intendedActiveRef.current) startSession();
          }, 2000);
        } else {
          setIsActive(false);
          setAppState('idle');
        }
      };
      
      ws.onerror = () => {
        ws.close();
      }
    } catch (e) {
      console.warn(e);
      cleanupResources();
      if (intendedActiveRef.current) {
        setAppState('idle');
        reconnectTimeoutRef.current = setTimeout(() => {
          if (intendedActiveRef.current) startSession();
        }, 2000);
      } else {
        setIsActive(false);
        setAppState('idle');
      }
    }
  };

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoIntervalRef = useRef<any>(null);

  const cleanupResources = () => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    if (inputAudioCtxRef.current) {
      inputAudioCtxRef.current.close();
      inputAudioCtxRef.current = null;
    }
    if (outputAudioCtxRef.current) {
      outputAudioCtxRef.current.close();
      outputAudioCtxRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (videoIntervalRef.current) {
      clearInterval(videoIntervalRef.current);
      videoIntervalRef.current = null;
    }
  };

  const stopSession = () => {
    intendedActiveRef.current = false;
    releaseWakeLock();
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    cleanupResources();
    setIsActive(false);
    setAppState('idle');
  };

  const toggleListening = () => {
    if (isActive) stopSession();
    else startSession();
  };

  const getOrbStyle = () => {
    if (!isActive) return 'bg-gray-800 shadow-[0_0_30px_rgba(0,0,0,0.4)] hover:bg-gray-700';
    switch (appState) {
      case 'listening': return 'bg-rose-500 shadow-[0_0_50px_rgba(244,63,94,0.6)]';
      case 'speaking': return 'bg-fuchsia-500 shadow-[0_0_50px_rgba(217,70,239,0.6)]';
      default: return 'bg-gray-800 shadow-[0_0_30px_rgba(0,0,0,0.4)] hover:bg-gray-700';
    }
  };

  const getStatusText = () => {
    if (!isActive) return "Tap to turn on continuous mode";
    switch (appState) {
      case 'listening': return "I'm listening...";
      case 'speaking': return "Mayra is speaking";
      default: return "";
    }
  };

  const getIcon = () => {
    if (!isActive) return <Power size={48} className="text-gray-300" />;
    switch (appState) {
      case 'listening': return <Mic size={48} className="text-white" />;
      case 'speaking': return <Volume2 size={48} className="text-white" />;
      default: return <Sparkles size={48} className="text-white" />;
    }
  };

  return (
    <div className="min-h-screen bg-[#050505] flex flex-col items-center justify-center font-sans text-white overflow-hidden relative">
      <div className="absolute top-6 right-6 z-20">
        <button
          onClick={() => setShowTranscript(!showTranscript)}
          className="p-3 rounded-full bg-gray-900/80 hover:bg-gray-800 border border-white/10 transition-colors shadow-lg flex items-center justify-center gap-2"
        >
          <MessageSquareText size={20} className="text-gray-300" />
          <span className="text-xs font-medium tracking-wide uppercase text-gray-300 hidden sm:inline">
            Transcript
          </span>
        </button>
      </div>

      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <motion.div 
          animate={{ 
            scale: isActive && (appState === 'listening' || appState === 'speaking') ? [1, 1.2, 1] : 1,
            opacity: !isActive ? 0.05 : 0.2
          }}
          transition={{ repeat: Infinity, duration: 3, ease: "easeInOut" }}
          className={`absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[40vw] h-[40vw] min-w-[300px] min-h-[300px] rounded-full blur-[100px] transition-colors duration-1000 ${
            !isActive ? 'bg-gray-500' :
            appState === 'speaking' ? 'bg-fuchsia-500' : 
            appState === 'listening' ? 'bg-rose-500' : 'bg-gray-500'
          }`}
        />
      </div>

      <div className="z-10 flex flex-col items-center justify-center space-y-16">
        <div className="flex flex-col items-center space-y-2">
          <h1 className="text-3xl font-light text-gray-200 tracking-[0.2em] uppercase flex items-center gap-3">
            Mayra
            {isActive && appState === 'speaking' && (
              <motion.div animate={{ scale: [1, 1.2, 1] }} transition={{ repeat: Infinity, duration: 1 }}>
                <Heart size={20} className="text-rose-500 fill-rose-500" />
              </motion.div>
            )}
          </h1>
          <p className="text-xs text-rose-500/80 tracking-widest font-medium uppercase">
            {isActive ? 'Active Mode' : 'Voice Assistant'}
          </p>
        </div>
        
        <motion.button
          onClick={toggleListening}
          animate={
            !isActive ? { scale: 1 } :
            appState === 'speaking' 
              ? { scale: [1, 1.15, 1] } 
              : appState === 'listening' 
                ? { scale: [1, 1.05, 1] } 
                : { scale: 1 }
          }
          transition={{ 
            repeat: Infinity, 
            duration: appState === 'speaking' ? 1.5 : 2, 
            ease: "easeInOut" 
          }}
          className={`w-40 h-40 md:w-56 md:h-56 rounded-full flex items-center justify-center transition-all duration-500 ease-in-out cursor-pointer z-10 ${getOrbStyle()}`}
        >
          {getIcon()}
        </motion.button>
        
        <p className="text-lg text-gray-400 font-light min-h-8 transition-opacity duration-300 flex items-center gap-2">
          {getStatusText()}
          {appState === 'speaking' && <Heart size={16} className="text-fuchsia-400/80" />}
        </p>
      </div>

      <div className="absolute bottom-6 left-6 z-20">
        <div className={`relative overflow-hidden rounded-2xl border transition-all duration-700 ${isActive ? 'w-24 h-32 border-white/20 shadow-[0_0_20px_rgba(255,255,255,0.1)]' : 'w-0 h-0 border-transparent opacity-0'}`}>
          <video ref={videoRef} autoPlay playsInline muted className="absolute inset-0 w-full h-full object-cover transform scale-x-[-1]" />
          <canvas ref={canvasRef} className="hidden" />
          {isActive && (
             <div className="absolute inset-0 bg-gradient-to-t from-black/60 to-transparent flex items-end p-2">
                <span className="text-[9px] uppercase tracking-wider font-medium text-white/90">Vision Active</span>
             </div>
          )}
        </div>
      </div>
      
      <div className="absolute bottom-8 right-6 text-[10px] text-gray-600 tracking-[0.3em] font-medium uppercase text-center w-full pointer-events-none">
        {isActive ? 'Live Vision & Audio Enabled' : 'Ready'}
      </div>

      {/* Transcript Overlay */}
      <AnimatePresence>
        {showTranscript && (
          <motion.div
            initial={{ opacity: 0, x: 300 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 300 }}
            transition={{ type: "spring", damping: 25, stiffness: 200 }}
            className="absolute right-0 top-0 bottom-0 w-full md:w-[400px] bg-black/80 backdrop-blur-xl border-l border-white/10 z-30 flex flex-col shadow-2xl"
          >
            <div className="flex items-center justify-between p-6 border-b border-white/10">
              <div className="flex items-center gap-4">
                <h2 className="text-sm font-medium tracking-widest uppercase text-gray-300">Live Transcript</h2>
                {messages.length > 0 && (
                  <button 
                    onClick={() => { setMessages([]); localStorage.removeItem('mayra_history'); }}
                    className="text-[10px] tracking-wider text-rose-500/80 hover:text-rose-400 uppercase font-medium transition-colors border border-rose-500/20 px-2 py-1 rounded-sm"
                  >
                    Clear Memory
                  </button>
                )}
              </div>
              <button 
                onClick={() => setShowTranscript(false)}
                className="p-2 rounded-full hover:bg-white/10 transition-colors"
              >
                <X size={20} className="text-gray-400" />
              </button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {messages.length === 0 ? (
                <div className="h-full flex items-center justify-center text-center">
                  <p className="text-sm text-gray-500 font-light max-w-[200px]">
                    No messages yet. Tap the orb to start chatting.
                  </p>
                </div>
              ) : (
                messages.map((msg, idx) => (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    key={idx}
                    className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
                  >
                    <span className="text-[10px] tracking-wider text-gray-500 mb-2 uppercase font-semibold">
                      {msg.role === 'user' ? 'You' : 'Mayra'}
                    </span>
                    <div 
                      className={`px-5 py-3 rounded-2xl max-w-[85%] text-sm font-light leading-relaxed ${
                        msg.role === 'user' 
                          ? 'bg-rose-500/10 text-rose-100 border border-rose-500/20 rounded-tr-sm' 
                          : 'bg-white/5 text-gray-200 border border-white/10 rounded-tl-sm'
                      }`}
                    >
                      {msg.text}
                    </div>
                  </motion.div>
                ))
              )}
              <div ref={messagesEndRef} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}


