require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 3001,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  
  // Verified working models for this API key
  MODELS: {
    LIVE: process.env.LIVE_MODEL || 'gemini-3.8-live',
    TTS: process.env.TTS_MODEL || 'gemini-3.8-flash-tts',
    TRANSLATE: 'gemini-3.5-live-translate-preview',
    ANALYSIS: process.env.ANALYSIS_MODEL || 'gemini-3.8-flash',
    TRANSCRIBE: process.env.TRANSCRIBE_MODEL || 'gemini-3.5-transcribe',
  },

  // Audio settings
  AUDIO: {
    INPUT_SAMPLE_RATE: 16000,
    OUTPUT_SAMPLE_RATE: 24000,
    CHANNELS: 1,
    ENCODING: 'LINEAR16',
  },

  // Intervention thresholds
  THRESHOLDS: {
    CONFIDENCE_RED: 40,
    CONFIDENCE_YELLOW: 65,
    EMOTIONAL_RED: -50,
    MIN_EVENTS_BEFORE_INTERVENTION: 3,
  },
};
