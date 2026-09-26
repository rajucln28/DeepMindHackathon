/**
 * AEGIS V2 — API Smoke Test Suite
 * Validates actual API key capabilities, active models, and real-time responses.
 */

const { GoogleGenAI } = require('@google/genai');
const config = require('./config');
const GeminiLiveSession = require('./geminiLive');
const GeminiTTS = require('./geminiTTS');

async function runSmokeTest() {
  console.log('=============================================');
  console.log('   AEGIS V2 — API CAPABILITIES SMOKE TEST   ');
  console.log('=============================================\n');

  let passed = 0;
  let failed = 0;

  // Test 1: Gemini 3.8 Flash Content Generation
  console.log('[TEST 1/3] Testing Gemini 3.8 Flash (Analysis / JSON)...');
  try {
    const ai = new GoogleGenAI({ apiKey: config.GEMINI_API_KEY });
    const res = await ai.models.generateContent({
      model: config.MODELS.ANALYSIS,
      contents: 'Output a JSON object with key "status" and value "active"',
      config: { responseMimeType: 'application/json' }
    });
    const parsed = JSON.parse(res.text);
    if (parsed.status === 'active') {
      console.log('  ✓ Gemini 3.8 Flash operational! Output:', res.text.trim());
      passed++;
    } else {
      throw new Error(`Unexpected JSON response: ${res.text}`);
    }
  } catch (err) {
    console.error('  ✗ Gemini 3.8 Flash failed:', err.message);
    failed++;
  }

  // Test 2: Gemini 3.8 Flash TTS
  console.log('\n[TEST 2/3] Testing Gemini 3.8 Flash TTS (Audio Synthesis)...');
  try {
    const tts = new GeminiTTS();
    let audioBytes = 0;
    await tts.speak(
      'Warning: System inconsistency detected.',
      (chunk) => {
        audioBytes += chunk.length;
      }
    );
    if (audioBytes > 0) {
      console.log(`  ✓ Gemini 3.8 Flash TTS operational! Synthesized ${audioBytes} base64 audio chars.`);
      passed++;
    } else {
      throw new Error('TTS produced 0 audio bytes');
    }
  } catch (err) {
    console.error('  ✗ Gemini 3.8 Flash TTS failed:', err.message);
    failed++;
  }

  // Test 3: Gemini 3.8 Live Bidirectional Streaming & Tool Calling
  console.log('\n[TEST 3/3] Testing Gemini 3.8 Live (WebSocket Bidi & Event Tool Emission)...');
  try {
    let eventReceived = null;
    const session = new GeminiLiveSession(
      (event) => {
        eventReceived = event;
      },
      (err) => console.error('  Session error:', err.message)
    );

    await session.connect();
    
    // Send simulated conversational conflict
    session.sendText('Speaker 1: Launch is confirmed for 9 AM. Speaker 2: Launch is completely cancelled.');

    // Wait up to 5 seconds for event tool emission
    const start = Date.now();
    while (!eventReceived && Date.now() - start < 5000) {
      await new Promise(r => setTimeout(r, 200));
    }

    session.close();

    if (eventReceived) {
      console.log(`  ✓ Gemini 3.8 Live operational! Received tool event: [${eventReceived.event_type}]`);
      console.log(`    Description: "${eventReceived.description}"`);
      console.log(`    Confidence: ${eventReceived.confidence}%, Speaker: ${eventReceived.speaker_id || 'unknown'}`);
      passed++;
    } else {
      throw new Error('Did not receive emit_world_event tool call within 5s');
    }
  } catch (err) {
    console.error('  ✗ Gemini 3.8 Live failed:', err.message);
    failed++;
  }

  console.log('\n=============================================');
  console.log(`Smoke Test Complete: ${passed}/3 Passed, ${failed} Failed`);
  console.log('=============================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runSmokeTest();
