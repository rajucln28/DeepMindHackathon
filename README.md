# RescueRoom

**The voice that keeps high-stakes conversations honest.** Built for the Google DeepMind Hackathon (Hyderabad, Sep 2026), Track 2: Next-Gen Voice & Real-Time Audio.

RescueRoom is an audio-only coordinator. It listens to a live English and Hindi conversation, tells people apart by voice, and keeps one shared picture of what has been said and agreed. When two accounts conflict, it asks aloud, in each person's language, and links every claim to the original audio. Tone shapes how it behaves. A loud "Stop!" cuts it off mid-word so it can replan. Every consequential action needs a human dispatcher's confirmation.

It uses five Gemini models: Live, Live Translate, Flash, Flash TTS and Transcribe. A deeper technical write-up is in [aegis-v2/README.md](aegis-v2/README.md).

---
# This project is deloyed in GCP anyone can access it from here: https://rescueroom-399152622050.asia-south1.run.app

## Quick start

### 1. Prerequisites
- **Node.js 20 or newer** (`node -v` to check)
- **Google Chrome** (or another Chromium browser). Mic capture and audio playback need it.
- A **Gemini API key** with access to the models in the table below
- **Headphones** are recommended for live mode, to avoid echo

### 2. Install
```bash
git clone https://github.com/rajucln28/DeepMindHackathon.git
cd DeepMindHackathon/aegis-v2
npm run setup
```

### 3. Add your API key
Create the file `aegis-v2/server/.env`. Start from the template:

**macOS / Linux / Git Bash**
```bash
cp server/.env.example server/.env
```
**Windows PowerShell**
```powershell
Copy-Item server\.env.example server\.env
```
Then open `server/.env` and set:
```
GEMINI_API_KEY=your_key_here
```
The key stays on the server. It is never sent to the browser, and `.env` is git-ignored.

### 4. Run
```bash
npm start
```
This builds the client and starts the server. Wait for these two lines in the terminal:
```
[boot] RescueRoom on http://localhost:3001
[boot] chime cached (...)
```
Then open **http://localhost:3001** in Chrome.

### 5. Use it
| Button | What it does |
|---|---|
| **▶ Demo fallback** | Plays a pre-recorded three-voice incident through your speakers and runs it through the real live models. Use this first to see the whole flow, and as the backup if the mic misbehaves. |
| **🎙 Go live** | Uses your real microphone. Allow the mic when Chrome asks. |
| **End incident** | Stops listening. Transcribe re-listens to everything, the incident report appears, and RescueRoom speaks a summary. |

Check the four status lights at the top (**Server, Mic, Live, Translate**). Start speaking once Live and Translate are green.

---

## Try a live run (three people)

Sit about 50 cm to 1 m from one shared mic and leave about a second of silence between speakers.

| # | Who | Says | What happens |
|---|---|---|---|
| 1 | **Ramesh**, field responder (Hindi, urgent) | "कंट्रोल, मैं रमेश, फील्ड टीम से। वेस्ट ब्रिज के पास एक आदमी मलबे में फँसा है, उसे साँस लेने में दिक्कत हो रही है!" | Facts appear, urgency rises |
| 2 | **Family member** (Hindi, distressed) | "नहीं नहीं, मेरे पापा रेलवे ब्रिज के पास हैं, वेस्ट ब्रिज पर नहीं! प्लीज़ जल्दी कीजिए!" | Contradiction detected. **Stay silent.** RescueRoom asks aloud. |
| 3 | **Arjun**, dispatcher (English) | "This is Arjun, dispatch. Ramesh's GPS puts him on West Bridge, and he can see the victim. The location is West Bridge." | Contradiction resolved |
| 4 | Arjun | "Create an urgent medical response to West Bridge, critical priority." | Action card and safety gate. **Wait** for "…Confirm?" |
| 5 | Arjun | "Confirm." | Tools run, status spoken in English and Hindi |
| 6 | Ramesh, about 2 seconds into that speech, loudly | "Stop! North entrance बंद है, पेड़ गिरा है। South road से आना होगा।" | RescueRoom cuts off, replans, reroutes |
| 7 | Anyone | Click **▶ Play evidence A / B**, then **End incident** | Original voices play, then the report |

**Tips:** each person says their name in their first line. Only the dispatcher's "Confirm" counts. If the voice "Confirm" isn't picked up, click **✔ Confirm as dispatcher** on the action card.

---

## Models used

| Model (default ID) | Role |
|---|---|
| `gemini-3.8-live` | Always-on live captions, and a fast conflict check |
| `gemini-3.5-live-translate-preview` | Live English rendering of Hindi speech |
| `gemini-3.8-flash` | Per-utterance audio analysis, reasoning and replies |
| `gemini-3.8-flash-tts` | Streamed, tone-aware spoken responses |
| `gemini-3.5-transcribe` | Word-for-word transcript and the final report |

Model IDs can be overridden in `server/.env` (`LIVE_MODEL`, `TTS_MODEL`, `ANALYSIS_MODEL`, `TRANSCRIBE_MODEL`, `TRANSLATE_MODEL`).

---

## Deploy to Google Cloud Run

Cloud Run gives a public HTTPS address, which Chrome needs for microphone access, and it supports the WebSocket audio stream.

```bash
cd aegis-v2
gcloud config set project YOUR_PROJECT_ID
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com artifactregistry.googleapis.com

# store the key as a secret (never bake it into the image)
printf '%s' "YOUR_GEMINI_KEY" | gcloud secrets create gemini-api-key --data-file=-
gcloud secrets add-iam-policy-binding gemini-api-key   --member="serviceAccount:$(gcloud projects describe YOUR_PROJECT_ID --format='value(projectNumber)')-compute@developer.gserviceaccount.com"   --role=roles/secretmanager.secretAccessor

gcloud run deploy rescueroom --source . --region asia-south1 --allow-unauthenticated   --port 8080 --cpu 1 --memory 1Gi --timeout 3600 --session-affinity   --min-instances 1 --max-instances 2 --concurrency 20 --no-cpu-throttling   --set-secrets GEMINI_API_KEY=gemini-api-key:latest
```
The command prints the service URL. To stop all charges afterwards: `gcloud run services delete rescueroom --region asia-south1`.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Server stops right away, or every call fails | `GEMINI_API_KEY` is missing or wrong in `server/.env` |
| `Live` or `Translate` light stays amber or red | Check your key's access to those preview models. The app reconnects automatically. |
| Port 3001 already in use | Set `PORT=3002` in `server/.env`, or stop the other process |
| No sound from RescueRoom | Click the page once before starting, and check the browser tab isn't muted |
| RescueRoom talks over itself or cuts itself off | Use headphones. In live mode the mic can hear the speakers. |
| Nothing is picked up in live mode | Allow the mic in Chrome, and check the **Mic** light is green |
| The demo fallback cannot find its audio | The recorded clips are in `aegis-v2/server/demo/`. Regenerate them with `npm --prefix server run make-demo` |

Headless end-to-end test (server must be running): `npm run e2e` from `aegis-v2/`.

---

## Project layout

```
aegis-v2/
  client/                Vite + TypeScript UI (mic capture, playback queue, dashboard)
    src/main.ts          dashboard, barge-in, demo fallback
    src/audio.ts         mic capture and streaming playback that can be cut instantly
    public/pcm-worklet.js  audio worklet (16 kHz PCM)
  server/
    index.js             Express + WebSocket entry point
    session.js           per-call pipeline: VAD, Live, Translate, actions, speech
    analyzer.js          Flash prompt and schema for each utterance
    worldState.js        shared incident state, safety gate, action rules
    tools.js             mock tools (nothing real is dispatched)
    gemini.js            Gemini wrappers (Live, TTS, Transcribe, Flash)
    demo/                pre-recorded voices for the fallback
    e2e.js               headless full-scenario test
```

## Safety notes
- RescueRoom **recommends; a human confirms.** Nothing consequential runs without a dispatcher's confirmation.
- All tools are **mocks.** No real emergency service is contacted.
- Vocal readings are shown as **observable signals with confidence**, not diagnoses.

## Team
- rajucln28
