// Local server for the demo: serves the folder, runs the replay clock and the alert engine, pushes through
// ntfy, and answers the phone's claim page. The ElevenLabs proxy for the story is unchanged.
//   node app/serve.mjs                         then open http://localhost:8000/app/
//   DATASET=history/snapshot_2026-10-10T0900   pick the dataset (default history/full_week)
//   NTFY_DRY_RUN=1                              log pushes instead of sending them
//   PUBLIC_URL=https://xyz.trycloudflare.com    where the phone reaches this server (claim links)
// Optional: ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID, PORT, NTFY_SERVER, NTFY_TOKEN
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createNotifier } from './notify.mjs';

const APP = path.dirname(fileURLToPath(import.meta.url));
// app/.env (git-ignored) may hold KEY=VALUE lines; real env vars win.
try { for (const l of fs.readFileSync(path.join(APP, '.env'), 'utf8').split('\n')) { const m = /^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/.exec(l); if (m && !process.env[m[1]]) process.env[m[1]] = m[2]; } } catch {}
const require = createRequire(import.meta.url);
const M = require('./model.js'), A = require('./alerts.js');
const ROOT = path.resolve(APP, '..'); // repo root: app/ + HackUTD-ZeroDay/
const DATA = path.join(ROOT, 'HackUTD-ZeroDay');
const CACHE = path.join(APP, 'voice-cache');
const PORT = +process.env.PORT || 8000;
const PUBLIC_URL = (process.env.PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const KEY = process.env.ELEVENLABS_API_KEY;
const VOICE = process.env.ELEVENLABS_VOICE_ID || 'JBFqnCBsd6RMkjVDRZzb';
const MODEL = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.csv': 'text/csv', '.md': 'text/markdown', '.png': 'image/png', '.mp3': 'audio/mpeg', '.css': 'text/css' };
fs.mkdirSync(CACHE, { recursive: true });

// ---------- alert system: dataset + replay clock + engine ----------
const roles = JSON.parse(fs.readFileSync(path.join(APP, 'roles.json'), 'utf8'));
const notifier = createNotifier({ appDir: APP });
const sim = { dataset: null, ds: null, rep: null, eng: null, i: -1, playing: false, speed: 36, carry: 0, last: 0, error: null };

function loadDataset(folder) {
  const dir = path.join(DATA, folder);
  const rd = f => fs.readFileSync(path.join(dir, f), 'utf8');
  const ds = M.loadDataset(JSON.parse(rd('network.json')), JSON.parse(rd('ops.json')), rd('telemetry.csv'));
  Object.assign(sim, { dataset: folder, ds, eng: null, rep: M.createReplay(ds), i: -1, playing: false, carry: 0, last: 0 });
  sim.eng = freshEngine(ds);
  seek(0);
  console.log(`dataset ${folder}: ${ds.tel.rows.toLocaleString()} readings, ${ds.facs.length} facilities, ${sim.eng.state().people.length} people`);
}
function freshEngine(ds) {
  const people = A.defaultPeople(ds, roles).map(p => ({ ...p, topic: p.virtual ? null : notifier.topicFor(p.id) }));
  const { people: _p, _comment, ...cfg } = roles;
  return A.createAlertEngine({ M, ds, people, config: { ...cfg, publicUrl: PUBLIC_URL }, notify: (p, m) => { notifier.send(p, m); } });
}
// Time travel with pushes muted, so it never buzzes the phone. The model stream is rebuilt from 0 (a few ms).
// Forward: the engine only sees the new ticks, so claims survive. Backward: the engine starts over.
function seek(t) {
  const { ds } = sim; t = Math.max(0, Math.min(ds.tel.n - 1, t | 0));
  if (t < sim.i) sim.eng = freshEngine(ds);
  const seen = t < sim.i ? -1 : sim.i;
  sim.rep = M.createReplay(ds); sim.eng.setMuted(true);
  for (let j = 0; j <= t; j++) { sim.rep.step(j); if (j > seen) sim.eng.tick(j, sim.rep.engine); }
  sim.i = t; sim.eng.setMuted(false);
}
function advance() {
  if (!sim.playing) return;
  const now = Date.now(), dt = sim.last ? (now - sim.last) / 1000 : 0; sim.last = now;
  sim.carry += dt * sim.speed;
  let steps = Math.floor(sim.carry); sim.carry -= steps;
  while (steps-- > 0 && sim.i < sim.ds.tel.n - 1) {
    if (sim.eng.waiting()) { sim.carry = 0; break; } // a human decision is pending: hold the clock
    sim.i++; sim.rep.step(sim.i); sim.eng.tick(sim.i, sim.rep.engine);
  }
  if (sim.i >= sim.ds.tel.n - 1) sim.playing = false;
}
setInterval(advance, 50);

function stateJson() {
  const { ds, eng, rep } = sim;
  const E = eng.state();
  const real = E.people.filter(p => !p.virtual).map(p => ({ id: p.id, topic: notifier.topicFor(p.id), subscribe: `${notifier.server}/${notifier.topicFor(p.id)}` }));
  return { dataset: sim.dataset, i: sim.i, n: ds.tel.n, t0: ds.tel.t0, playing: sim.playing, speed: sim.speed, public_url: PUBLIC_URL, dry_run: notifier.dryRun, real_phones: real, totals: rep.totals(), pushes: notifier.sent().slice(-30), ...E };
}

async function body(req) { let s = ''; for await (const c of req) { s += c; if (s.length > 1e6) throw new Error('too long'); } return s ? JSON.parse(s) : {}; }
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };

async function api(req, res, url) {
  const p = url.pathname;
  try {
    if (p === '/api/state') return json(res, 200, stateJson());
    if (p === '/api/replay' && req.method === 'POST') {
      const b = await body(req);
      if (b.speed) sim.speed = +b.speed;
      if (b.seek != null) { sim.playing = false; seek(+b.seek); }
      if (b.play === true) { if (sim.i >= sim.ds.tel.n - 1) seek(0); sim.playing = true; sim.last = 0; }
      if (b.play === false) sim.playing = false;
      if (b.pauseOnWait != null) sim.eng.cfg.pauseOnWait = !!b.pauseOnWait;
      return json(res, 200, { i: sim.i, playing: sim.playing, speed: sim.speed });
    }
    if (p === '/api/dataset' && req.method === 'POST') { const b = await body(req); loadDataset(String(b.folder)); return json(res, 200, { dataset: sim.dataset }); }
    if (p === '/api/claim' && req.method === 'POST') { const b = await body(req); return json(res, 200, sim.eng.act(String(b.token || ''), String(b.action || 'claim'))); }
    if (p === '/api/heartbeat' && req.method === 'POST') { const b = await body(req); return json(res, 200, { ok: sim.eng.heartbeat(String(b.token || '')), now_ts: sim.eng.state().now_ts }); }
    if (p.startsWith('/api/person/') && req.method === 'POST') { const b = await body(req); return json(res, 200, { ok: sim.eng.setReachable(decodeURIComponent(p.slice(12)), !!b.reachable) }); }
    if (p.startsWith('/api/alert/')) { const v = sim.eng.forToken(p.slice(11)); return v ? json(res, 200, v) : json(res, 404, { error: 'unknown or expired link' }); }
    if (p === '/api/events.json') { res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="events.json"' }); return res.end(JSON.stringify(M.exportEvents(sim.ds, sim.rep.engine, sim.i), null, 2)); }
    if (p === '/api/audit') { res.writeHead(200, { 'content-type': 'application/json', 'content-disposition': 'attachment; filename="audit.json"' }); return res.end(JSON.stringify(sim.eng.audit(), null, 2)); }
    if (p === '/api/datasets') { const out = []; for (const d of ['history', 'test']) { const dir = path.join(DATA, d); if (!fs.existsSync(dir)) continue; if (fs.existsSync(path.join(dir, 'telemetry.csv'))) out.push(d); else for (const s of fs.readdirSync(dir)) if (fs.existsSync(path.join(dir, s, 'telemetry.csv'))) out.push(d + '/' + s); } return json(res, 200, out); }
    return json(res, 404, { error: 'no such api' });
  } catch (e) { console.error('api', p, e.message); return json(res, 400, { error: e.message }); }
}

// ---------- ElevenLabs proxy (story narration) ----------
async function tts(req, res) {
  let text;
  try { text = String((await body(req)).text || '').trim(); } catch { return send(res, 400, 'bad json'); }
  if (!text || text.length > 1500) return send(res, 400, 'text must be 1–1500 chars');
  const file = path.join(CACHE, crypto.createHash('sha1').update(`${VOICE}|${MODEL}|${text}`).digest('hex') + '.mp3');
  if (fs.existsSync(file)) return stream(res, file, 'audio/mpeg', { 'x-cache': 'hit' });
  if (!KEY) return send(res, 503, 'ELEVENLABS_API_KEY not set');
  try {
    const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_44100_128`, {
      method: 'POST', headers: { 'xi-api-key': KEY, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({ text, model_id: MODEL, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    });
    if (!r.ok) { const msg = (await r.text()).slice(0, 300); console.error('ElevenLabs', r.status, msg); return send(res, 502, `ElevenLabs ${r.status}`); }
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(file + '.tmp', buf); fs.renameSync(file + '.tmp', file);
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': buf.length, 'x-cache': 'miss' }); res.end(buf);
  } catch (e) { console.error('tts failed:', e.message); send(res, 502, 'tts failed'); }
}

function send(res, code, msg) { res.writeHead(code, { 'content-type': 'text/plain' }); res.end(msg); }
function stream(res, file, type, extra = {}) { res.writeHead(200, { 'content-type': type, 'content-length': fs.statSync(file).size, ...extra }); fs.createReadStream(file).pipe(res); }

loadDataset(process.env.DATASET || 'history/full_week');

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/')) return api(req, res, url);
  if (url.pathname.startsWith('/claim/')) return stream(res, path.join(APP, 'claim.html'), 'text/html');
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
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Glass Box on http://localhost:${PORT}/app/  ·  story: /app/story.html  ·  claim links use ${PUBLIC_URL}`);
  console.log(notifier.dryRun ? 'ntfy DRY RUN: pushes are logged, not sent' : `ntfy ${notifier.server}: subscribe your phone to ${notifier.topicFor('control_room')}`);
  console.log(KEY ? `ElevenLabs voice ON (voice ${VOICE}, model ${MODEL})` : 'ElevenLabs key not set: story falls back to the browser voice (cached clips still play)');
});
