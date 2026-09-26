# RescueRoom: audio-first incident coordination

**Track 2: Next-Gen Voice & Real-Time Audio**

RescueRoom listens to an emergency call where several people speak English, Hindi and Hinglish, interrupt each other, and correct themselves. It keeps one shared picture of the incident. When reports disagree, it asks a clarifying question aloud. It turns verified information into actions behind a safety gate, and it speaks to each person in their own language. When someone shouts "Stop! the road is blocked", it stops talking at once and changes the plan.

There is no text box. The audio is the evidence, and every conclusion can be traced back to the original voice clip.

## What typing can't reproduce

| Audio-only capability | Where you see it |
|---|---|
| **Vocal intensity and signals** (pace, pitch, distress cues). Presented as observable signals, not diagnoses. | Participant cards, each log entry, urgency level |
| **Barge-in:** a human talks over RescueRoom, playback cuts mid-word, and the new information changes the plan | "Interrupted" banner, `BARGE_IN` then `PLAN_CHANGED` then `ACTION_REROUTED` |
| **Cross-language contradictions**, with **Play evidence A / B** giving the original voices | Contradictions panel |
| **Replies per person, in their language** (Hindi to the family and field worker, English to the dispatcher) | RescueRoom voice panel |
| **Speaker identity from the voice itself** | Participants panel |

## The models and what each one does

| Model | Job |
|---|---|
| **Gemini 3.8 Live** | Always-open stream. Live captions as people speak. Feeds the text fast path, which raises "⚡ possible conflict" about 2–3s after speech ends. |
| **Gemini 3.5 Live Translate** | A live English version of Hindi speech |
| **Gemini 3.8 Flash** (audio in) | One call per utterance. Returns transcript, language, vocal signals, urgency, speaker and role, claims, contradictions and resolutions, action requests, confirmations, plan updates, and replies per person. Runs as a hedged request (two calls, first answer wins). |
| **Gemini 3.8 Flash TTS** | Streamed voice with inline delivery tags. It starts synthesising before RescueRoom is allowed to speak. |
| **Gemini 3.5 Transcribe** | Word-for-word transcript per utterance, and a full re-listen for the final report |

## How it works

```
mic ─► server VAD ─┬─► Live (captions) ─► fast contradiction check
                   ├─► Live Translate (English bridge)
                   └─► utterance ─┬─► Flash (audio + incident state) ─► reducer ─► shared incident state
                                  └─► Transcribe (evidence)                         │
      ┌─────────────────────────────────────────────────────────────────────────────┘
      ├─ contradiction ─► open question ─► spoken clarification (per person)
      ├─ action request ─► SAFETY GATE (location verified? requester authorised? confidence? high impact?)
      │                     └─► read-back "Confirm?" ─► human confirms (voice or console)
      │                           └─► mock tools in parallel: lookup_location, get_weather,
      │                               knowledge_lookup ─► create_task, send_notification
      └─ "STOP + new info" ─► barge-in cuts audio ─► PLAN_CHANGED ─► tools re-run ─► reroute spoken
```

**Safety gate rules:**
- A dispatch requested while the location is disputed is **BLOCKED**.
- Only a dispatcher can confirm. A family member saying "confirm" is refused, and the refusal is shown on screen.
- RescueRoom recommends; a human confirms. The tools are mocks, and nothing real is ever dispatched.

## Run

```bash
npm run setup
cp server/.env.example server/.env    # add GEMINI_API_KEY
npm start                              # builds client, serves http://localhost:3001
```

- **● Go live** is live mode with the real mic. Headphones are recommended; an echo guard is built in.
- **▶ Demo fallback** plays pre-recorded voices through the speakers and runs them through the same live models. It's labelled on screen.
- **■ End incident** has Transcribe re-listen to everything. It produces the incident report and RescueRoom speaks a summary.
- `npm run e2e` is a headless run of the whole scenario that prints every event and tool call. The server must be running.
