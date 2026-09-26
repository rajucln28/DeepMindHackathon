require('dotenv').config({ quiet: true });

module.exports = {
  PORT: Number(process.env.PORT) || 3001,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',

  MODELS: {
    LIVE: process.env.LIVE_MODEL || 'gemini-3.8-live',
    TTS: process.env.TTS_MODEL || 'gemini-3.8-flash-tts',
    TRANSLATE: process.env.TRANSLATE_MODEL || 'gemini-3.5-live-translate-preview',
    ANALYSIS: process.env.ANALYSIS_MODEL || 'gemini-3.8-flash',
    TRANSCRIBE: process.env.TRANSCRIBE_MODEL || 'gemini-3.5-transcribe',
  },

  VOICE: 'Zephyr',

  VAD: {
    FRAME: 320,             // 20ms at 16kHz
    MIN_RMS: 450,           // absolute floor for speech
    NOISE_MULT: 3,          // speech = rms > noiseFloor * NOISE_MULT
    START_FRAMES: 3,        // 60ms of speech opens an utterance
    END_SILENCE_MS: 700,    // silence that closes an utterance
    MIN_SPEECH_MS: 500,
    MAX_UTTERANCE_MS: 14000,
    PREROLL_MS: 250,
  },

  INTERVENTION: {
    COOLDOWN_MS: 8000,
    // Tone controller, measured from the END of the triggering utterance.
    BACKOFF_ANGRY_MS: 2500,   // let a heated speaker finish and cool down
    BACKOFF_DEFAULT_MS: 0,
    QUIET_ANGRY_MS: 800,      // required silence before speaking to a heated room
    QUIET_DEFAULT_MS: 250,
    MAX_WAIT_FOR_SILENCE_MS: 5000,
  },
};
