/**
 * Gemini Flash TTS — streaming text-to-speech for interventions.
 * Uses the @google/genai SDK to generate spoken audio from text.
 */

const { GoogleGenAI } = require('@google/genai');
const config = require('./config');

class GeminiTTS {
  constructor() {
    this.client = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
  }

  /**
   * Generate speech from text and return base64-encoded PCM audio chunks.
   * @param {string} text - The text to speak.
   * @param {function} onAudioChunk - Callback (base64Audio) for each audio chunk.
   * @param {function} onComplete - Callback when TTS is finished.
   */
  async speak(text, onAudioChunk, onComplete) {
    try {
      console.log(`[TTS] Generating speech: "${text.substring(0, 60)}..."`);

      const response = await this.client.models.generateContent({
        model: config.MODELS.TTS,
        contents: [{ parts: [{ text: `Please speak the following clearly and with authority: ${text}` }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: 'Kore',
              },
            },
          },
        },
      });

      // Extract audio from response
      if (response.candidates && response.candidates[0]) {
        const parts = response.candidates[0].content?.parts || [];
        for (const part of parts) {
          if (part.inlineData && part.inlineData.data) {
            if (onAudioChunk) onAudioChunk(part.inlineData.data);
          }
        }
      }

      if (onComplete) onComplete();
    } catch (err) {
      console.error('[TTS] Error generating speech:', err.message);
      if (onComplete) onComplete(err);
    }
  }
}

module.exports = GeminiTTS;
