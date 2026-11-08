// ntfy adapter: one topic per person, random suffix so nobody can guess a topic, claim link as a tap action.
// NTFY_DRY_RUN=1 logs instead of sending. Topics are generated once into app/.env (NTFY_TOPIC_<PERSON>=...).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export function createNotifier({ appDir, server = process.env.NTFY_SERVER || 'https://ntfy.sh', dryRun = !!process.env.NTFY_DRY_RUN, token = process.env.NTFY_TOKEN, onSend = () => {} }) {
  const envFile = path.join(appDir, '.env');
  const sent = [];

  // Topic for a person: from env, else generated and appended to app/.env so it survives restarts.
  function topicFor(personId) {
    const key = 'NTFY_TOPIC_' + personId.toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (process.env[key]) return process.env[key];
    const t = `${personId.toLowerCase().replace(/[^a-z0-9]/g, '-')}-${crypto.randomBytes(6).toString('hex')}`;
    process.env[key] = t;
    try { fs.appendFileSync(envFile, `\n${key}=${t}`); } catch {}
    return t;
  }

  async function send(person, msg) {
    const topic = person.topic || topicFor(person.id);
    // JSON publish (UTF-8 safe for the emoji titles). One tap opens the claim page, which shows the alert's
    // current state before anyone drives anywhere.
    const payload = { topic, title: msg.title || 'Alert', message: msg.message || '', priority: msg.priority || 3, tags: msg.tags || [], click: msg.url || undefined,
      actions: msg.url && msg.actions ? msg.actions.slice(0, 3).map(a => ({ action: 'view', label: a.label, url: `${msg.url}?do=${a.action}`, clear: true })) : undefined };
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const rec = { at: new Date().toISOString(), to: person.id, topic, kind: msg.kind, tags: msg.tags || [], title: msg.title, message: msg.message, priority: msg.priority, url: msg.url, replay_ts: msg.replay_ts, dryRun };
    sent.push(rec); if (sent.length > 500) sent.shift();
    onSend(rec);
    if (dryRun || person.virtual) return rec; // virtual people live on the dashboard only
    try {
      const r = await fetch(server, { method: 'POST', headers, body: JSON.stringify(payload) });
      rec.status = r.status; if (!r.ok) rec.error = (await r.text()).slice(0, 200);
    } catch (e) { rec.error = e.message; }
    return rec;
  }

  return { send, topicFor, sent: () => sent, dryRun, server };
}
