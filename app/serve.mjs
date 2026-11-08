// Local server for the demo: serves the hack-utd folder and proxies ElevenLabs text-to-speech.
// The API key stays here (env var), never in the browser. Every clip is cached as an MP3 in app/voice-cache/.
//   ELEVENLABS_API_KEY=... node app/serve.mjs        then open http://localhost:8000/app/story.html
// Optional: ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID, PORT
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const APP = path.dirname(fileURLToPath(import.meta.url));
// app/.env (git-ignored) may hold KEY=VALUE lines; real env vars win.
try { for (const l of fs.readFileSync(path.join(APP, '.env'), 'utf8').split('\n')) { const m = /^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
const ROOT = path.resolve(APP, '..'); // hack-utd: app/ + HackUTD-ZeroDay/
const CACHE = path.join(APP, 'voice-cache');
const PORT = +process.env.PORT || 8000;
const KEY = process.env.ELEVENLABS_API_KEY;
const VOICE = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb'; // a premade ElevenLabs voice; swap for any voice id in your account
const MODEL = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.csv': 'text/csv', '.md': 'text/markdown', '.png': 'image/png', '.mp3': 'audio/mpeg', '.css': 'text/css' };
fs.mkdirSync(CACHE, { recursive: true });

async function tts(req, res) {
  let body = '';
  for await (const c of req) { body += c; if (body.length > 8000) return send(res, 413, 'too long'); }
  let text;
  try { text = String(JSON.parse(body).text || '').trim(); } catch { return send(res, 400, 'bad json'); }
  if (!text || text.length > 1500) return send(res, 400, 'text must be 1–1500 chars');
  const file = path.join(CACHE, crypto.createHash('sha1').update(`${VOICE}|${MODEL}|${text}`).digest('hex') + '.mp3');
  if (fs.existsSync(file)) return stream(res, file, 'audio/mpeg', { 'x-cache': 'hit' });
  if (!KEY) return send(res, 503, 'ELEVENLABS_API_KEY not set');
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });
    if (!r.ok) { const msg = (await r.text()).slice(0, 300); console.error('ElevenLabs', r.status, msg); return send(res, 502, `ElevenLabs ${r.status}`); }
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(file + '.tmp', buf); fs.renameSync(file + '.tmp', file); // no half-written cache files
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': buf.length, 'x-cache': 'miss' }); res.end(buf);
  } catch (e) { console.error('tts failed:', e.message); send(res, 502, 'tts failed'); }
}

function send(res, code, msg) { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(msg); }
function stream(res, file, type, extra = {}) { res.writeHead(200, { 'content-type': type, 'content-length': fs.statSync(file).size, ...extra }); fs.createReadStream(file).pipe(res); }

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/tts') return req.method === 'POST' ? tts(req, res) : send(res, 405, 'POST only');
  if (url.pathname === '/tts/status') return res.end(JSON.stringify({ elevenlabs: !!KEY, voice: VOICE, model: MODEL }));
  let p = path.resolve(ROOT, '.' + decodeURIComponent(url.pathname));
  if (!p.startsWith(ROOT + path.sep) && p !== ROOT) return send(res, 403, 'forbidden'); // no path traversal
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  if (!fs.existsSync(p)) return send(res, 404, 'not found');
  stream(res, p, TYPES[path.extname(p)] || 'application/octet-stream');
}).on('error', e => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`Port ${PORT} is already in use by another program. Try another port:\n  PORT=${PORT + 1} node app/serve.mjs`);
  process.exit(1);
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Glass Box on http://localhost:${PORT}/app/story.html  ·  live console: /app/`);
  console.log(KEY ? `ElevenLabs voice ON (voice ${VOICE}, model ${MODEL}), cache: ${CACHE}` : 'ElevenLabs key not set: story falls back to the browser voice (cached clips still play)');
});
