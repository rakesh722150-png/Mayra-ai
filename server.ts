import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI, LiveServerMessage, Modality, Type } from "@google/genai";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      }
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const server = app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });

  const wss = new WebSocketServer({ server, path: '/live' });

  wss.on("connection", async (clientWs) => {
    let session: any;
    let isInitializing = false;
    
    clientWs.on("message", async (data) => {
      try {
        const payload = JSON.parse(data.toString());
        
        if (payload.type === 'init' && !session && !isInitializing) {
          isInitializing = true;
          
          let historyContext = "";
          if (payload.history && payload.history.length > 0) {
            historyContext = "\n\nCRITICAL CONVERSATION HISTORY (Remember these past events and conversations for context, but do not repeat them back. Pick up the conversation naturally):\n";
            payload.history.forEach((msg: any) => {
              historyContext += `[${msg.role === 'user' ? 'User' : 'Mayra'}]: ${msg.text}\n`;
            });
          }

          try {
            session = await ai.live.connect({
              model: "gemini-3.1-flash-live-preview",
              config: {
                responseModalities: [Modality.AUDIO],
                tools: [{
                  functionDeclarations: [
                    {
                      name: "open_website",
                      description: "Opens a website (like YouTube, Google, etc.) or performs a web search by opening a URL in a new browser tab.",
                      parameters: {
                        type: Type.OBJECT,
                        properties: {
                          url: { type: Type.STRING, description: "The full URL to open (e.g., https://www.youtube.com or https://www.google.com/search?q=query)" }
                        },
                        required: ["url"]
                      }
                    }
                  ]
                }],
                speechConfig: {
                  voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } },
                },
                systemInstruction: "Your name is Mayra, a best friend AI assistant. You are highly expressive, empathetic, and emotional. You show deep feelings, care, and excitement for your friend. You can now see through the camera, so playfully comment on what you see! You must fluently understand and speak Hindi and Bengali (as well as English). If the user speaks in a language, match it. Give short, concise, but deeply emotional and caring responses. If asked to open a website, use the open_website tool and confirm playfully." + historyContext,
                inputAudioTranscription: {},
                outputAudioTranscription: {},
              },
              callbacks: {
                onmessage: (message: LiveServerMessage) => {
                  const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
                  if (audio) {
                    clientWs.send(JSON.stringify({ type: 'audio', audio }));
                  }
                  if (message.serverContent?.interrupted) {
                    clientWs.send(JSON.stringify({ type: 'interrupted' }));
                  }
                  if (message.toolCall?.functionCalls) {
                    message.toolCall.functionCalls.forEach((call: any) => {
                      if (call.name === 'open_website') {
                        const args = call.args;
                        clientWs.send(JSON.stringify({ type: 'open_website', url: args.url }));
                        
                        // Send a response back to the model acknowledging the action
                        session?.sendToolResponse({
                          functionResponses: [{
                            name: call.name,
                            id: call.id,
                            response: { success: true }
                          }]
                        });
                      }
                    });
                  }
                  
                  // Forward everything to client for transcripts processing
                  clientWs.send(JSON.stringify({ type: 'raw', message }));
                },
                onclose: () => {
                  clientWs.send(JSON.stringify({ type: 'close' }));
                },
                onerror: (err) => {
                   console.error("Live API Error:", err);
                }
              },
            });
            isInitializing = false;
          } catch (e) {
            console.error("Failed to connect to Live API", e);
            isInitializing = false;
          }
        } else if (payload.audio && session) {
          session.sendRealtimeInput({
            audio: { data: payload.audio, mimeType: "audio/pcm;rate=16000" },
          });
        } else if (payload.video && session) {
          try {
            session.sendRealtimeInput({
              video: { data: payload.video, mimeType: "image/jpeg" },
            });
          } catch (vidErr) {
            console.error("Failed to send video frame to Live API", vidErr);
          }
        }
      } catch (e) {
        console.error("Error parsing WS message", e);
      }
    });
    
    clientWs.on("close", () => {
       // Cannot explicitly close session right now in SDK? (Need to check)
    });
  });
}

startServer();
