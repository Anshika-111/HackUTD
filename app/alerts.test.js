// node app/alerts.test.js [dataset-folder]   Drives the alert engine over a recorded week with scripted people.
// No network: pushes are collected in memory. Exits 1 on any failed check.
const fs = require('fs'), path = require('path'), M = require('./model.js'), A = require('./alerts.js');
const dir = process.argv[2] || path.join(__dirname, '..', 'HackUTD-ZeroDay', 'history', 'full_week');
const rd = f => fs.readFileSync(path.join(dir, f), 'utf8');
const ds = M.loadDataset(JSON.parse(rd('network.json')), JSON.parse(rd('ops.json')), rd('telemetry.csv'));
let fails = 0; const check = (ok, msg) => { console.log((ok ? 'ok   ' : 'FAIL ') + msg); if (!ok) fails++; };

// Scenario runner: `script(eng, pushes, i)` acts as the humans each tick.
function run(script, cfg = {}) {
  const pushes = [];
  const people = A.defaultPeople(ds, { people: [{ id: 'control_room', virtual: true }] }); // scripted control room
  const eng = A.createAlertEngine({ M, ds, people, config: { pauseOnWait: false, repingWallSec: 0, ...cfg }, notify: (p, m) => pushes.push({ ...m, i: eng._S.i }), random: (() => { let x = 1; return () => ((x = (x * 48271) % 2147483647) / 2147483647); })() }); // deterministic tokens
  const rep = M.createReplay(ds);
  for (let i = 0; i < ds.tel.n; i++) { rep.step(i); eng.tick(i, rep.engine); script && script(eng, pushes, i); }
  return { eng, pushes, rep };
}
const ids = s => new Set(s.alerts.map(a => a.id));

// 1) Diligent control room: approves every plan on the first push, drivers claim at once.
{
  const { eng, pushes, rep } = run((eng) => {
    for (const p of eng.state().people) for (const t of p.tokens) if (t.kind !== 'queue') eng.act(t.token, t.kind === 'task' ? 'done' : 'claim');
  });
  const st = eng.state();
  const events = rep.engine.events;
  check(st.alerts.length === events.length, `one alert per model event (${st.alerts.length} alerts, ${events.length} events)`);
  check(events.every(e => ids(st).has(e.event_id)), 'alert ids are the model event ids');
  const fails13 = st.alerts.filter(a => a.category === 'pump_failure');
  const noAction = fails13.filter(a => a.do_nothing_cost === 0);
  check(fails13.length === 13, `13 pump-failure alerts (${fails13.length})`);
  check(fails13.filter(a => !noAction.includes(a)).every(a => a.approve_by_first_ts), 'every actionable failure has an approve-by time');
  const dup = pushes.filter(p => p.tags && p.tags.includes('new') && p.kind === 'alert');
  check(dup.length === new Set(dup.map(p => p.refId)).size, 'a new alert is pushed once (updated in place afterwards)');
  const jobs = st.jobs; check(jobs.length > 0 && jobs.every(j => j.state === 'done' || j.state === 'covered'), `all ${jobs.length} truck jobs were covered`);
  check(jobs.every(j => j.claims.length === j.trucks), 'every truck job got exactly as many claims as trucks');
  check(!eng.audit().some(e => e.action === 'replan'), 'no re-plan needed: trucks already out were counted before approval');
  check(st.tasks.length > 0 && st.tasks.every(t => t.state === 'done'), `${st.tasks.length} shut-in tasks were scheduled and done`);
  const onFail = eng.audit().filter(e => e.action === 'queue_cancel' && e.detail === 'pump failed');
  check(st.queue.length >= 3 && onFail.length === 3, `${st.queue.length} worn pumps queued for inspection; the 3 that later failed were cancelled on failure (${onFail.length})`);
  console.log(`info leak alerts: ${st.alerts.filter(a => a.category === 'pipeline_leak').length}`);
  check(st.audit_total > 50, `audit log has ${st.audit_total} entries`);
  check(!eng.audit().some(e => e.action === 'deadline_missed'), 'no deadline missed when approvals are prompt');
  // Opening scene (EVENT_9: S1_FACILITY_C on 10-08): approve by about 03:30 and the fallback is a shut-in, not a shutdown.
  const a9 = st.alerts.find(a => a.facility_id === 'S1_FACILITY_C' && a.onset_unix >= Date.parse('2026-10-08T00:00:00Z') / 1000);
  check(!!a9, 'opening-scene alert exists');
  if (a9) {
    check((a9.approve_by_first_ts || '').startsWith('2026-10-08T03:'), `opening scene approve-by ${a9.approve_by_first_ts} (truck needs 75 min, shutdown 04:49)`);
    check(a9.fallback && a9.fallback.label.includes('shut in') && a9.fallback.cost < 2500, `fallback is "${a9.fallback && a9.fallback.label}" at $${a9.fallback && a9.fallback.cost}, not a $5k shutdown`);
  }
  check(pushes.some(p => p.kind === 'handoff'), 'shift handoff pushes went out');
}
// 1b) Slow approver on the 10-10 S4 morning (3 failures within an hour): one bundle, shared fleet respected.
{
  const T = Date.parse('2026-10-10T08:05:00Z') / 1000;
  const { eng } = run((eng) => {
    const st = eng.state();
    for (const p of st.people) for (const t of p.tokens) {
      if (t.kind === 'alert') { const a = st.alerts.find(a => a.id === t.ref); if (a.system_id === 'S4' && st.now < T && st.now >= Date.parse('2026-10-10T06:00:00Z') / 1000) continue; eng.act(t.token, 'claim'); }
      else if (t.kind !== 'queue') eng.act(t.token, t.kind === 'task' ? 'done' : 'claim');
    }
  });
  const st = eng.state(); const b = st.bundles.find(b => b.alerts.length === 3);
  check(!!b, 'the three S4 failures were approved as one bundle');
  if (b) { const trucks = b.alerts.reduce((n, id) => n + (st.alerts.find(a => a.id === id).approved_plan?.trucks || 0), 0); check(trucks <= 2, `bundle uses ${trucks} trucks, fleet is 2`); }
  check(st.alerts.filter(a => a.system_id === 'S4' && a.onset_unix >= Date.parse('2026-10-10T07:00:00Z') / 1000).every(a => a.severity === 'critical' || a.approved_at), 'late approval drove severity to critical before approval');
}
// 1c) First N claims win: force a job to every driver, then a second claimer is told it is covered.
{
  let done = false, res = null;
  const { eng } = run((eng) => {
    if (done) return; const st = eng.state();
    for (const p of st.people) for (const t of p.tokens) if (t.kind === 'alert') eng.act(t.token, 'claim');
    const j = eng.state().jobs.find(j => j.state === 'open' && j.trucks === 1 && j.system_id === 'S3'); if (!j) return; // S3 has 3 drivers
    for (const d of j.pinged) eng.setReachable(d, false); // first driver drops: job goes to every free driver
    const toks = eng.state().people.filter(p => p.role === 'driver' && p.system === j.system_id && p.reachable).flatMap(p => p.tokens.filter(t => t.ref === j.id));
    if (toks.length >= 2) { const r1 = eng.act(toks[0].token, 'claim'), r2 = eng.act(toks[1].token, 'claim'); res = [r1.result, r2.result]; done = true; }
  });
  check(res && res[0] === 'claimed' && res[1] === 'covered', `first claim wins, second told covered (${res})`);
}
// 2) Absent control room: escalates to the backup supervisor, re-pings every 5 min, and the plan degrades past the deadline.
{
  const { eng } = run(null);
  const st = eng.state(), au = eng.audit();
  check(au.some(e => e.action === 'escalate' && e.detail.includes('backup_supervisor')), 'unclaimed alert escalated to the backup supervisor');
  check(au.filter(e => e.action === 'reping').length > 5, `re-pinged while unclaimed (${au.filter(e => e.action === 'reping').length} re-pings)`);
  check(au.some(e => e.action === 'deadline_missed'), 'approve-by passed: logged as deadline missed');
  check(au.some(e => e.action === 'resend'), 'a critical alert left unclaimed was re-sent once after 1 minute');
  check(au.some(e => e.action === 'replan'), 'the plan was replaced by the fallback after the deadline');
  const openEsc = au.find(e => e.action === 'escalate'); const openAt = au.find(e => e.action === 'open' && e.ref === openEsc.ref);
  const waitMin = (Date.parse(openEsc.ts_replay) - Date.parse(openAt.ts_replay)) / 60000;
  check(waitMin >= 2 && waitMin <= 10, `escalation waited ${waitMin} replay minutes (2..10, scaled to the deadline)`);
  check(st.alerts.filter(a => a.category === 'pump_failure').every(a => a.state === 'resolved'), 'every alert still closes when the model resolves the event');
}
// 3) Drivers decline: the truck job re-plans to a shut-in instead of turning red.
{
  const { eng } = run((eng) => {
    for (const p of eng.state().people) for (const t of p.tokens) {
      if (t.kind === 'alert') eng.act(t.token, 'claim');
      else if (t.kind === 'job') eng.act(t.token, 'decline');
      else if (t.kind === 'task') eng.act(t.token, 'done');
    }
  });
  const au = eng.audit();
  check(au.some(e => e.action === 'replan' && e.detail.includes('no free driver')), 'all drivers declined => automatic re-plan');
  check(au.some(e => e.action === 'replan' && e.detail.includes('shut in')), 're-plan produced a shut-in plan');
  check(eng.state().jobs.every(j => j.state !== 'open'), 'no truck job left open');
}
// 4) Lost signal: a driver toggled unreachable is skipped at once.
{
  let toggled = false;
  const { eng } = run((eng) => {
    const st = eng.state();
    for (const p of st.people) for (const t of p.tokens) if (t.kind === 'alert') eng.act(t.token, 'claim');
    const j = st.jobs.find(j => j.state === 'open');
    if (j && !toggled) { toggled = true; for (const d of j.pinged) eng.setReachable(d, false); }
  });
  const au = eng.audit();
  check(au.some(e => e.action === 'reachability' && e.detail.includes('lost')), 'lost-signal toggle logged');
  const lost = au.find(e => e.action === 'reachability'); const esc = au.find(e => e.action === 'escalate' && e.ref.startsWith('JOB') && e.ts_replay === lost.ts_replay);
  check(!!esc, 'job escalated in the same replay minute the driver lost signal (no wait)');
}
// 5) Pause-on-wait: with the default config the engine reports waiting while a decision is pending.
{
  const people = A.defaultPeople(ds);
  const eng = A.createAlertEngine({ M, ds, people, notify: () => {} });
  const rep = M.createReplay(ds); let waitedAt = null;
  for (let i = 0; i < ds.tel.n; i++) { rep.step(i); eng.tick(i, rep.engine); if (eng.waiting()) { waitedAt = i; break; } }
  check(waitedAt != null, `engine asks the replay to pause at tick ${waitedAt} (${eng.state().now_ts})`);
  const t = eng.state().people.find(p => p.id === 'control_room'); // real phone: no tokens in state
  check(t.tokens.length === 0, 'the real phone has no dashboard tokens (claim goes through the push link)');
  const st = eng.state(); const a = st.alerts.find(a => a.state === 'awaiting_approval' || a.state === 'awaiting_claim');
  const tok = [...eng._S.tokens.entries()].find(([, v]) => v.refId === a.id)[0];
  const r = eng.act(tok, 'claim'); check(r.ok && !eng.waiting(), 'claiming through the token clears the wait');
}
console.log(fails ? `\n${fails} check(s) failed` : '\nALL ALERT CHECKS PASS'); process.exitCode = fails ? 1 : 0;
