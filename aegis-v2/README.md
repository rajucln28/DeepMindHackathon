# AEGIS — Real-time Meeting Guardian

**Track 2 · Next-Gen Voice & Real-Time Audio**

AEGIS listens to a live meeting and keeps a model of what has been said and agreed. When two people say things that can't both be true, even across English and Hindi, it speaks up without being asked. The wording depends on how the speaker sounds. Anyone can talk over it to stop it. Every conflict links to the two audio clips that caused it.

Audio is the only input. There is no text box.

## How the four audio models are used

| Model | Job in AEGIS | Why it's needed |
|---|---|---|
| **Gemini 3.8 Live** | Always-open bidirectional stream. Live captions of what's being said as people speak. Feeds the fast path. | Reacts before anyone finishes a thought |
| **Gemini 3.5 Live Translate** | Streams an English version of Hindi speech in real time | Cross-language meetings |
| **Gemini 3.8 Flash** (audio in) | Hears each utterance and returns transcript, language, **acoustic tone**, speaker match by voice, facts, contradictions and resolutions against the world state. Also runs the text-only fast check and writes the brief. | The brain |
| **Gemini 3.8 Flash TTS** | Streams AEGIS's spoken intervention. Tone tags (`[warm]`, `[serious]`) set its delivery. It starts synthesising before AEGIS is allowed to speak. | The voice |
| **Gemini 3.5 Transcribe** | Ground-truth verbatim transcript per utterance, and a full re-listen of the meeting for the end brief | Evidence and trust |

## The loop

```
mic ─► server VAD ─┬─► Live (captions) ──► fast text check ──► "⚡ possible conflict" (~2–3s)
                   ├─► Live Translate (English bridge)
                   └─► utterance ─┬─► Flash hears audio + world state ─► world model ─► tone policy ─► Flash TTS ─► speaker
                                  └─► Transcribe (ground truth)                              ▲
                human talks over AEGIS ─► barge-in (client + server VAD) ─► audio cut ─┘
```

**Tone controls what AEGIS does:**
- **Frustrated or angry:** AEGIS waits for the room to calm down, uses softer wording, and adds a line in Hindi if the speaker used Hindi.
- **Anxious or confused:** AEGIS speaks right away with grounding wording.
- **Otherwise:** AEGIS gives a short, neutral intervention.

**Latency tricks:**
- A pre-rendered "Hold on." chime plays instantly.
- TTS starts synthesising while AEGIS waits.
- Flash analysis runs as a hedged request (two calls, first answer wins).
- A text fast path runs in parallel with the full audio analysis.

## Run it

```bash
# one-time
npm run setup
cp server/.env.example server/.env   # add GEMINI_API_KEY

# build client + serve everything on :3001
npm start
# open http://localhost:3001
```

- **● Start listening** uses the live mic. Headphones are recommended; there's an echo guard, but headphones are safest.
- **▶ Scripted demo** plays a pre-rendered 3-voice meeting (English and Hindi) through the speakers and feeds it to the same pipeline. Use it as the stage fallback.
- **End & brief** has Transcribe re-listen to the whole meeting and Flash write the decisions, owners and open issues.

Headless test that streams the scripted meeting and prints every event: `npm run e2e`. The server must be running.

## Demo script (about 90 seconds)

1. **Arjun (EN):** "Hi, Arjun from finance. The migration budget is approved at five hundred thousand dollars, and we go live Friday."
2. **Priya (EN):** "Priya from infra. With that budget we finish the cutover Friday evening."
3. **Speaker 3 (HI, heated):** "नहीं नहीं, ये गलत है! बजट सिर्फ़ दो लाख डॉलर का मंज़ूर हुआ है।"
   - The Hindi caption and the English bridge appear live.
   - ⚡ The fast path flags a possible conflict.
   - Frustration is detected, so the tone policy backs off.
4. **AEGIS speaks without being asked,** softly and in both languages.
5. **Arjun talks over it:** "Aegis, stop. I just checked the email, the extra three hundred thousand was approved. Five hundred thousand, final." AEGIS goes quiet, the conflict is resolved and the state returns to GREEN.
6. **Click ▶ on the contradiction card** to play the two original voices as evidence.
7. **Click End & brief.**
