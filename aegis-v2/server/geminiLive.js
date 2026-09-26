/**
 * Gemini Live Bidi Session Manager.
 * Manages the persistent WebSocket connection to Gemini Live API
 * using @google/genai SDK for real-time audio streaming and function calling.
 */

const { GoogleGenAI } = require('@google/genai');
const config = require('./config');
const { SYSTEM_PROMPT, EMIT_WORLD_EVENT_TOOL } = require('./systemPrompt');

class GeminiLiveSession {
  constructor(onEvent, onError) {
    this.ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    this.session = null;
    this.onEvent = onEvent; // Callback when a world event is emitted
    this.onError = onError;
    this.isSetup = false;
    this.sessionHandle = null;
  }

  /**
   * Connect to Gemini Live API and initialize bidirectional session.
   */
  async connect() {
    return new Promise((resolve, reject) => {
      console.log(`[GeminiLive] Connecting to Gemini Live using model: ${config.MODELS.LIVE}...`);

      let resolved = false;

      this.ai.live.connect({
        model: config.MODELS.LIVE,
        config: {
          systemInstruction: {
            parts: [{ text: SYSTEM_PROMPT }],
          },
          tools: [
            {
              functionDeclarations: [EMIT_WORLD_EVENT_TOOL],
            },
          ],
        },
        callbacks: {
          onopen: () => {
            console.log('[GeminiLive] WebSocket connected.');
          },
          onmessage: (msg) => {
            // Setup complete
            if (msg.setupComplete) {
              console.log('[GeminiLive] Setup complete!');
              this.isSetup = true;
              if (!resolved) {
                resolved = true;
                resolve();
              }
            }

            // Session resumption update
            if (msg.sessionResumptionUpdate) {
              this.sessionHandle = msg.sessionResumptionUpdate.newHandle;
              console.log(`[GeminiLive] Resumption handle: ${this.sessionHandle}`);
            }

            // Tool call (function calling)
            if (msg.toolCall) {
              const functionCalls = msg.toolCall.functionCalls || [];
              const responses = [];

              for (const call of functionCalls) {
                if (call.name === 'emit_world_event') {
                  console.log(`[GeminiLive] Event emitted: ${call.args.event_type} — ${call.args.description}`);
                  
                  // Fire the callback with the event data
                  if (this.onEvent) {
                    this.onEvent(call.args);
                  }

                  responses.push({
                    id: call.id,
                    name: call.name,
                    response: { status: 'recorded', event_type: call.args.event_type },
                  });
                }
              }

              // Send tool responses back to Gemini
              if (responses.length > 0 && this.session) {
                this.session.sendToolResponse({ functionResponses: responses });
              }
            }

            // Text content (log unexpected text)
            if (msg.serverContent?.modelTurn?.parts) {
              for (const part of msg.serverContent.modelTurn.parts) {
                if (part.text) {
                  console.log(`[GeminiLive] Model text: ${part.text}`);
                }
              }
            }
          },
          onerror: (err) => {
            console.error('[GeminiLive] WebSocket error:', err.message || err);
            if (this.onError) this.onError(err);
            if (!resolved) {
              resolved = true;
              reject(err);
            }
          },
          onclose: (e) => {
            console.log(`[GeminiLive] WebSocket closed: ${e?.code} ${e?.reason}`);
            this.isSetup = false;
          },
        },
      }).then((sess) => {
        this.session = sess;
      }).catch((err) => {
        console.error('[GeminiLive] Failed to connect:', err.message || err);
        if (!resolved) {
          resolved = true;
          reject(err);
        }
      });
    });
  }

  /**
   * Stream raw PCM audio chunks to Gemini Live.
   * Audio should be 16kHz, 16-bit, mono PCM, base64-encoded.
   */
  sendAudio(base64AudioChunk) {
    if (!this.session || !this.isSetup) return;

    try {
      this.session.sendRealtimeInput({
        mediaChunks: [
          {
            mimeType: 'audio/pcm;rate=16000',
            data: base64AudioChunk,
          },
        ],
      });
    } catch (err) {
      console.error('[GeminiLive] Error sending audio chunk:', err.message);
    }
  }

  /**
   * Send raw binary PCM audio buffer directly.
   */
  sendAudioBuffer(buffer) {
    this.sendAudio(buffer.toString('base64'));
  }

  /**
   * Send text turn (e.g. for synthetic simulation or testing).
   */
  sendText(text) {
    if (!this.session || !this.isSetup) return;

    this.session.sendClientContent({
      turns: [
        {
          role: 'user',
          parts: [{ text }],
        },
      ],
      turnComplete: true,
    });
  }

  /**
   * Check if the session is connected and ready.
   */
  isReady() {
    return this.isSetup && !!this.session;
  }

  /**
   * Close the session.
   */
  close() {
    if (this.session) {
      try {
        this.session.close();
      } catch (e) {
        // ignore
      }
      this.session = null;
      this.isSetup = false;
    }
  }
}

module.exports = GeminiLiveSession;
