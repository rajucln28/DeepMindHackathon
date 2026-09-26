// AEGIS server: static client + one WebSocket per browser session.
const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const config = require('./config');
const { speakOnce } = require('./gemini');
const { Session, warmup } = require('./session');

const app = express();
const dist = path.join(__dirname, '..', 'client', 'dist');
if (fs.existsSync(dist)) app.use(express.static(dist));
app.use('/demo', express.static(path.join(__dirname, 'demo')));
app.get('/health', (_, res) => res.json({ ok: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  const send = (msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
  const session = new Session(send);
  console.log('[ws] client connected');

  ws.on('message', async (data, isBinary) => {
    if (isBinary) return session.pushAudio(Buffer.from(data));
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    switch (msg.type) {
      case 'start': session.start(msg.mode); break;
      case 'barge_in': session.bargeIn('client detected speech'); break;
      case 'audio_done': session.speechFinished(msg.id); break;
      case 'clip': send({ type: 'clip', key: msg.key, data: session.clip(msg.start, msg.end) }); break;
      case 'summary': session.summary(); break;
      case 'wrapup': session.wrapUp(); break;
    }
  });
  ws.on('close', () => { session.stop(); console.log('[ws] client disconnected'); });
});

server.listen(config.PORT, () => {
  console.log(`[boot] AEGIS on http://localhost:${config.PORT}`);
  warmup(speakOnce);
});
