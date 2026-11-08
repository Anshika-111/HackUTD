// Field alert engine: one alert per model event, severity from the approve-by deadline, escalation in
// replay time, plan bundles per system, truck jobs with "first N claims win", owned shut-in tasks,
// automatic re-plan when a truck job is declined, an inspection queue for worn pumps, and an audit log.
// Pure JS, no deps, no I/O: the clock is the replay, pushes go through an injected notify() callback.
// Same file runs in Node (require) and the browser (window.Alerts).
(function (root) {
  'use strict';

  const DEFAULTS = {
    criticalMin: 30,            // approve-by this close (replay minutes) => critical
    escalateMin: [2, 10],       // escalation wait = clamp(minutes_to_approve / 4, 2, 10)
    repingMin: 5,               // unclaimed alerts re-ping every N replay minutes until acknowledged
    repingWallSec: 60,          // ...but never more often than this in wall time (fast replay must not flood the phone)
    leakEscalateMin: 10,        // leaks are High: 10 min before the backup supervisor is pinged
    inspectionDeadlineHours: 24,// worn pump: inspect within this many hours of the warning
    wearHealthPct: 97, wearLossPerHr: 0.3, // heads-up trigger, from what the model emits
    heartbeatStaleSec: 90,      // wall seconds without a heartbeat => unreachable
    pauseOnWait: true,          // replay pauses while a human decision is pending
    shifts: ['06:00', '18:00'], // UTC shift changes for the handoff push
    publicUrl: '',              // claim links are publicUrl + /claim/<token>
  };

  function createAlertEngine({ M, ds, people, config = {}, notify = () => {}, random = Math.random, wallNow = () => Date.now() }) {
    const cfg = { ...DEFAULTS, ...config };
    const STEP = M.STEP;
    const S = {
      alerts: new Map(), jobs: new Map(), tasks: new Map(), queue: new Map(), audit: [], tokens: new Map(),
      people: new Map(), seq: 0, now: ds.tel.t0, i: -1, muted: false, lastShiftKey: null, bundles: new Map(),
    };
    for (const p of people) S.people.set(p.id, { buzzed: 0, idleSince: ds.tel.t0, reachable: true, lastHeartbeat: 0, ...p });

    const iso = t => new Date(t * 1000).toISOString().replace('.000', '');
    const hhmm = t => iso(t).slice(11, 16);
    const nid = pre => pre + '-' + String(++S.seq).padStart(4, '0');
    const money = v => '$' + Math.round(v).toLocaleString();
    const log = (action, actor, ref, detail) => { S.audit.push({ ts_replay: iso(S.now), ts_wall: new Date(wallNow()).toISOString(), actor, action, ref, detail }); };

    // ---------- people & routing ----------
    const reachable = p => p.reachable && (p.virtual || !p.lastHeartbeat || wallNow() - p.lastHeartbeat < cfg.heartbeatStaleSec * 1000);
    const byRole = role => [...S.people.values()].filter(p => p.role === role);
    const driversOf = sys => byRole('driver').filter(p => p.system === sys);
    const trucksBusy = sys => [...S.jobs.values()].filter(j => j.system_id === sys && j.state !== 'done' && j.state !== 'declined' && S.now < j.busy_until).reduce((a, j) => a + j.trucks, 0);
    const busyDrivers = () => new Set([...S.jobs.values()].filter(j => j.state !== 'done').flatMap(j => j.claims));
    const freeDrivers = sys => { const b = busyDrivers(); return driversOf(sys).filter(p => !b.has(p.id) && reachable(p)); };
    // Fair routing: fewest buzzes this shift, then idle the longest.
    const fair = list => list.slice().sort((a, b) => a.buzzed - b.buzzed || a.idleSince - b.idleSince);

    function tokenFor(personId, kind, refId) {
      for (const [t, v] of S.tokens) if (v.personId === personId && v.kind === kind && v.refId === refId) return t;
      let t; do { t = Array.from({ length: 24 }, () => '0123456789abcdef'[random() * 16 | 0]).join(''); } while (S.tokens.has(t)); // never reuse a token
      S.tokens.set(t, { personId, kind, refId }); return t;
    }
    const link = token => (cfg.publicUrl || '') + '/claim/' + token;

    function push(personId, kind, ref, payload) {
      const p = S.people.get(personId); if (!p) return;
      if (!S.muted) p.buzzed++;
      const token = tokenFor(personId, kind, ref.id);
      const msg = { ...payload, to: personId, topic: p.topic, token, url: link(token), kind, refId: ref.id, replay_ts: iso(S.now) };
      log('push', 'system', ref.id, `${payload.title} -> ${personId}${S.muted ? ' (muted: seek)' : ''}`);
      if (!S.muted) notify(p, msg);
    }

    // ---------- severity ----------
    function severityOf(a) {
      if (a.category === 'pump_failure') {
        if (a.tripped) return 'high';
        if (a.approve_by_unix == null) return 'low';
        const left = (a.approve_by_unix - S.now) / 60;
        return left <= cfg.criticalMin || !a.truck_possible ? 'critical' : 'high';
      }
      return a.category === 'pipeline_leak' ? 'high' : 'low';
    }
    const escalateWait = a => {
      if (a.category !== 'pump_failure' || a.approve_by_unix == null) return cfg.leakEscalateMin * 60;
      const left = (a.approve_by_unix - S.now) / 60 / 4;
      return Math.min(cfg.escalateMin[1], Math.max(cfg.escalateMin[0], left)) * 60;
    };

    // ---------- alert text ----------
    function describe(a) {
      if (a.category === 'pump_failure') {
        const sd = a.hours_to_limit?.p50 != null ? `shutdown ${hhmm(S.now + a.hours_to_limit.p50 * 3600)}` : 'tank level unknown';
        const by = a.approve_by_unix != null ? ` · approve by ${hhmm(a.approve_by_unix)}` : '';
        return { title: `${a.severity === 'critical' ? '🔴' : '🟠'} Pump failure ${a.facility_id}`, message: `${sd}${by}. Plan: ${a.plan.label} (${money(a.plan.cost)}). Miss it: +${money(a.cost_if_missed)}.` };
      }
      if (a.category === 'pipeline_leak') return { title: `🟠 Leak ${a.facility_id}`, message: `${a.evidence.join('; ')}. Schedule an inspector.` };
      return { title: `🟡 Worn pump ${a.facility_id}`, message: a.evidence.join('; ') };
    }
    function pushAlert(a, to, why) {
      const d = describe(a);
      push(to, 'alert', a, { ...d, priority: a.severity === 'critical' ? 5 : a.severity === 'high' ? 4 : 3, tags: [a.category, why], actions: [{ label: a.category === 'pump_failure' ? 'Approve plan' : 'Claim', action: 'claim' }, { label: "Can't", action: 'decline' }] });
      a.pinged = Array.from(new Set([...(a.pinged || []), to])); a.last_push_at = S.now; a.last_push_wall = wallNow();
    }

    // ---------- lifecycle: model events -> alerts ----------
    function upsertFailure(f, freeTrucks) {
      const e = f.ev; let a = S.alerts.get(e.event_id);
      const ab = M.approveBy(ds, f, freeTrucks);
      const fresh = {
        plan: f.plan, system_plan_cost: f.plan.cost, do_nothing: f.doNothing, hours_to_limit: f.hours_to_limit, level: f.level, tripped: f.tripped,
        approve_by_unix: ab.deadlineMin == null ? null : S.now + ab.deadlineMin * 60, fallback: ab.fallback, cost_if_missed: ab.costIfMissed, ladder: ab.ladder, truck_possible: !!ab.truckPossible,
      };
      if (!a) {
        a = { id: e.event_id, event_id: e.event_id, category: e.category, system_id: e.system_id, facility_id: e.facility_id, asset_id: e.asset_id,
          confidence: e.confidence, evidence: e.evidence, onset_unix: e.onset_unix, opened_at: S.now, state: 'awaiting_approval', escalation: 0,
          pinged: [], claimed_by: null, acked: false, next_ping_at: null, bundle_id: e.system_id, ...fresh };
        a.severity = severityOf(a); a.approve_by_first = a.approve_by_unix;
        if (f.doNothing === f.plan && !f.tripped) { a.state = 'no_action_needed'; } // tank peaks below shutdown: inform only
        S.alerts.set(a.id, a);
        log('open', 'model', a.id, `${a.category} ${a.facility_id} ${a.severity}${a.state === 'no_action_needed' ? ' (no action needed)' : ''}`);
        cancelInspection(a.asset_id, 'pump failed');
        if (a.state === 'awaiting_approval') { const cr = pickControl(); if (cr) pushAlert(a, cr.id, 'new'); a.escalate_at = S.now + escalateWait(a); }
        return a;
      }
      // Update in place. Before approval the plan follows the optimizer; after approval it is frozen.
      const before = a.plan.label, sevBefore = a.severity;
      a.evidence = e.evidence; a.confidence = e.confidence;
      Object.assign(a, { hours_to_limit: fresh.hours_to_limit, level: fresh.level, tripped: fresh.tripped, ladder: fresh.ladder });
      if (a.state === 'awaiting_approval' || a.state === 'no_action_needed') {
        Object.assign(a, { plan: fresh.plan, do_nothing: fresh.do_nothing, fallback: fresh.fallback, cost_if_missed: fresh.cost_if_missed, truck_possible: fresh.truck_possible });
        if (fresh.approve_by_unix != null && a.approve_by_unix != null && a.approve_by_unix <= S.now && fresh.approve_by_unix > S.now) {
          log('deadline_missed', 'system', a.id, `plan was "${before}", now "${fresh.plan.label}" (${money(fresh.plan.cost)})`);
        }
        a.approve_by_unix = fresh.approve_by_unix;
        if (a.plan.label !== before) { log('replan', 'model', a.id, `${before} -> ${a.plan.label}`); if (a.state === 'awaiting_approval') { const cr = pickControl(); if (cr) pushAlert(a, cr.id, 'plan changed'); } }
        if (a.state === 'no_action_needed' && a.plan !== a.do_nothing) { a.state = 'awaiting_approval'; a.escalate_at = S.now + escalateWait(a); const cr = pickControl(); if (cr) pushAlert(a, cr.id, 'now needs action'); }
      }
      a.severity = severityOf(a);
      if (a.severity !== sevBefore && a.state === 'awaiting_approval') { log('severity', 'system', a.id, `${sevBefore} -> ${a.severity}`); for (const p of a.pinged) pushAlert(a, p, 'severity'); }
      return a;
    }

    function upsertOther(e, i) {
      let a = S.alerts.get(e.event_id);
      const fac = ds.facs.find(f => f.id === e.facility_id);
      if (!a) {
        a = { id: e.event_id, event_id: e.event_id, category: e.category, system_id: e.system_id, facility_id: e.facility_id, asset_id: e.asset_id,
          confidence: e.confidence, evidence: e.evidence, onset_unix: e.onset_unix, opened_at: S.now, escalation: 0, pinged: [], claimed_by: null, acked: false };
        a.severity = severityOf(a);
        if (e.category === 'pipeline_leak') { a.state = 'awaiting_claim'; S.alerts.set(a.id, a); log('open', 'model', a.id, `leak ${a.facility_id}`); const cr = pickControl(); if (cr) pushAlert(a, cr.id, 'new'); a.escalate_at = S.now + escalateWait(a); }
        else { a.state = 'watching'; S.alerts.set(a.id, a); log('open', 'model', a.id, `worn pump ${a.asset_id}`); }
        return a;
      }
      a.evidence = e.evidence; a.confidence = e.confidence;
      if (e.category === 'pipeline_leak' && (a.state === 'claimed' || a.state === 'awaiting_confirmation')) {
        // A leak is invisible while the pump is off: its end can only be confirmed when the pump runs again.
        const pumpOn = fac && fac.s.pst[i] === 1;
        const want = pumpOn ? 'claimed' : 'awaiting_confirmation';
        if (want !== a.state) { a.state = want; log('state', 'system', a.id, want === 'awaiting_confirmation' ? 'pump off: leak status unknown until it runs' : 'pump running: leak still visible'); }
      }
      if (e.category === 'pump_degradation') maybeQueueInspection(a, e);
      return a;
    }

    // ---------- inspection queue (worn pumps) ----------
    function maybeQueueInspection(a, e) {
      if (S.queue.has(a.id)) return;
      if (!(e.health_pct <= cfg.wearHealthPct || e.loss_pct_per_hr >= cfg.wearLossPerHr)) return;
      const q = { id: a.id, alert_id: a.id, asset_id: a.asset_id, facility_id: a.facility_id, system_id: a.system_id, state: 'queued', owner: null,
        deadline_unix: S.now + cfg.inspectionDeadlineHours * 3600, reason: e.evidence.join('; ') };
      S.queue.set(q.id, q); a.state = 'inspection_queued';
      log('queue', 'system', a.id, `inspect ${a.asset_id} by ${iso(q.deadline_unix)}: ${q.reason}`);
      const insp = byRole('inspector').filter(reachable)[0];
      if (insp) push(insp.id, 'queue', q, { title: `🟡 Inspect ${a.asset_id} by ${hhmm(q.deadline_unix)}`, message: q.reason + '. One notice, no escalation.', priority: 3, tags: ['inspection'], actions: [{ label: 'Take it', action: 'claim' }] });
    }
    function cancelInspection(assetId, why) {
      for (const q of S.queue.values()) if (q.asset_id === assetId && q.state !== 'done' && q.state !== 'cancelled') { q.state = 'cancelled'; log('queue_cancel', 'system', q.id, why); }
    }

    // ---------- approval -> bundle -> jobs & tasks ----------
    function pickControl() { const cr = byRole('control_room').filter(reachable)[0]; return cr || byRole('backup_supervisor').filter(reachable)[0] || null; }

    function approveBundle(a, actor) {
      // Approve every failure in this system that is awaiting approval as one bundle: the optimizer split
      // the shared fleet across them, so approving one tank at a time could break the split.
      const members = [...S.alerts.values()].filter(x => x.category === 'pump_failure' && x.system_id === a.system_id && x.state === 'awaiting_approval');
      const bid = nid('BUNDLE'); S.bundles.set(bid, { id: bid, system_id: a.system_id, alerts: members.map(m => m.id), approved_by: actor, at: S.now });
      log('approve', actor, bid, `${members.map(m => `${m.facility_id}: ${m.plan.label}`).join(' | ')}`);
      for (const m of members) {
        m.state = 'approved'; m.claimed_by = actor; m.acked = true; m.bundle_id = bid; m.approved_plan = m.plan; m.approved_at = S.now; m.escalate_at = null; m.next_ping_at = null;
        materialize(m);
        for (const p of m.pinged) if (p !== actor) push(p, 'alert', m, { title: `✅ Covered: ${m.facility_id}`, message: `${actor} approved the plan. Stand down.`, priority: 2, tags: ['covered'] });
        if (m.jobs.length === 0 && m.tasks.length === 0) { m.state = 'in_progress'; }
      }
    }
    function materialize(a) {
      a.jobs = a.jobs || []; a.tasks = a.tasks || [];
      for (const act of a.approved_plan.actions) {
        if (act.type === 'dispatch_truck') {
          const j = { id: nid('JOB'), alert_id: a.id, bundle_id: a.bundle_id, system_id: a.system_id, facility_id: a.facility_id, trucks: act.trucks, trips: act.trips_per_truck,
            claims: [], declined: [], pinged: [], state: 'open', escalation: 0, claim_by_unix: a.approve_by_unix ?? (S.now + 30 * 60), created_at: S.now, next_ping_at: null, busy_until: S.now + (a.approved_plan.busyMin || 0) * 60 };
          S.jobs.set(j.id, j); a.jobs.push(j.id);
          routeJob(j, 'new');
        } else if (act.type === 'shut_in_wells') {
          const t = { id: nid('TASK'), alert_id: a.id, system_id: a.system_id, facility_id: a.facility_id, wells: act.wells, due_unix: S.now + act.start_after_min * 60, owner: pickControl()?.id || null, state: 'scheduled', pushed: false };
          S.tasks.set(t.id, t); a.tasks.push(t.id);
          log('task', 'system', t.id, `shut in ${act.wells.join(', ')} at ${hhmm(t.due_unix)} (owner ${t.owner})`);
        }
      }
      a.state = 'in_progress';
    }
    function routeJob(j, why) {
      const need = j.trucks - j.claims.length;
      const pool = freeDrivers(j.system_id).filter(p => !j.declined.includes(p.id));
      const targets = j.escalation === 0 ? fair(pool).slice(0, need) : pool;
      for (const p of targets) pushJob(j, p.id, why);
      j.escalate_at = S.now + (j.escalation === 0 ? Math.min(cfg.escalateMin[1], Math.max(cfg.escalateMin[0], Math.max(0, (j.claim_by_unix - S.now) / 60 / 4))) * 60 : cfg.repingMin * 60);
      if (!targets.length && j.escalation > 0) replanWithout(j, 'no free driver in ' + j.system_id);
    }
    function pushJob(j, to, why) {
      const a = S.alerts.get(j.alert_id);
      push(to, 'job', j, { title: `🚚 Truck to ${j.facility_id}`, message: `${j.trips} trip${j.trips > 1 ? 's' : ''}, ${j.trucks} truck${j.trucks > 1 ? 's' : ''} needed. Leave by ${hhmm(j.claim_by_unix)}; shutdown ${a?.hours_to_limit?.p50 != null ? hhmm(S.now + a.hours_to_limit.p50 * 3600) : '?'}.`, priority: 4, tags: ['truck', why], actions: [{ label: 'Claim', action: 'claim' }, { label: "Can't", action: 'decline' }] });
      if (!j.pinged.includes(to)) j.pinged.push(to);
    }
    // Nobody will drive: switch the alert to the next-cheapest plan with the trucks we actually have.
    function replanWithout(j, why) {
      const a = S.alerts.get(j.alert_id); if (!a || j.state !== 'open') return;
      const have = j.claims.length;
      j.state = have ? 'partial' : 'declined';
      const fsx = M.failureState(ds, { onset_unix: a.onset_unix, facility_id: a.facility_id }, S.i);
      const t = M.planOne(ds, fsx, have), P = t.best[have];
      const before = a.approved_plan.label;
      a.approved_plan = P; a.plan = P;
      log('replan', 'system', a.id, `${why}: "${before}" -> "${P.label}" (${money(P.cost)})`);
      j.trucks = have; if (have) j.state = 'covered';
      for (const act of P.actions) if (act.type === 'shut_in_wells') {
        const tk = { id: nid('TASK'), alert_id: a.id, system_id: a.system_id, facility_id: a.facility_id, wells: act.wells, due_unix: S.now + act.start_after_min * 60, owner: pickControl()?.id || null, state: 'scheduled', pushed: false, from_replan: true };
        S.tasks.set(tk.id, tk); a.tasks.push(tk.id);
      }
      const cr = pickControl(); if (cr) push(cr.id, 'alert', a, { title: `🔁 Plan changed ${a.facility_id}`, message: `${why}. New plan: ${P.label} (${money(P.cost)}).`, priority: 4, tags: ['replan'], actions: [{ label: 'Acknowledge', action: 'ack' }] });
    }

    // ---------- timers (replay clock) ----------
    function timers() {
      for (const a of S.alerts.values()) {
        if (a.state === 'awaiting_approval' || a.state === 'awaiting_claim') {
          if (a.severity === 'critical' && !a.acked && !a.resent && a.last_push_at != null && S.now - a.last_push_at >= 60) {
            a.resent = true; log('resend', 'system', a.id, 'critical, unclaimed after 1 min'); for (const p of a.pinged) pushAlert(a, p, 'resend');
          }
          if (a.escalate_at != null && S.now >= a.escalate_at) {
            if (a.escalation === 0) {
              a.escalation = 1; const bk = byRole('backup_supervisor').filter(reachable);
              log('escalate', 'system', a.id, `no claim in time; pinging ${bk.map(b => b.id).join(', ') || 'nobody reachable'}`);
              for (const b of bk) pushAlert(a, b.id, 'escalation');
              a.escalate_at = null; a.next_ping_at = S.now + cfg.repingMin * 60; a.red = true;
            }
          }
          if (a.next_ping_at != null && !a.acked && S.now >= a.next_ping_at && (S.muted || wallNow() - (a.last_push_wall || 0) >= cfg.repingWallSec * 1000)) {
            log('reping', 'system', a.id, `still unclaimed`); for (const p of a.pinged) pushAlert(a, p, 'reminder'); a.next_ping_at = S.now + cfg.repingMin * 60;
          }
        }
      }
      for (const j of S.jobs.values()) if (j.state === 'open') {
        if (S.now >= j.claim_by_unix) { replanWithout(j, 'nobody claimed the truck before ' + hhmm(j.claim_by_unix)); continue; }
        if (j.escalate_at != null && S.now >= j.escalate_at) { j.escalation++; log('escalate', 'system', j.id, `truck job to all free drivers in ${j.system_id}`); routeJob(j, 'escalation'); }
      }
      for (const t of S.tasks.values()) if (t.state === 'scheduled' && S.now >= t.due_unix) {
        t.state = 'due'; log('task_due', 'system', t.id, `shut in ${t.wells.join(', ')} now`);
        if (t.owner) push(t.owner, 'task', t, { title: `⏱ Shut in ${t.wells.join(', ')} now`, message: `${t.facility_id}: part of the approved plan. Tap Done when the wells are off.`, priority: 5, tags: ['shut_in'], actions: [{ label: 'Done', action: 'done' }] });
      }
      // Shift handoff
      const d = new Date(S.now * 1000), key = d.toISOString().slice(0, 10) + ' ' + d.toISOString().slice(11, 16);
      for (const sh of cfg.shifts) if (key.endsWith(' ' + sh) && S.lastShiftKey !== key) { S.lastShiftKey = key; handoff(); }
    }
    function handoff() {
      const A = [...S.alerts.values()].filter(a => !['resolved', 'closed'].includes(a.state));
      const open = A.filter(a => ['awaiting_approval', 'awaiting_claim'].includes(a.state)), prog = A.filter(a => ['in_progress', 'approved', 'claimed', 'awaiting_confirmation'].includes(a.state));
      const lines = [`Open, nobody on it: ${open.length ? open.map(a => a.facility_id + ' ' + a.category.replace('_', ' ')).join(', ') : 'none'}`,
        `In progress: ${prog.length ? prog.map(a => a.facility_id + (a.claimed_by ? ' (' + a.claimed_by + ')' : '')).join(', ') : 'none'}`,
        `Waiting on approval: ${open.filter(a => a.category === 'pump_failure').map(a => `${a.facility_id} by ${hhmm(a.approve_by_unix || S.now)}`).join(', ') || 'none'}`];
      S.lastHandoff = { at: iso(S.now), lines };
      log('handoff', 'system', 'shift', lines.join(' / '));
      const cr = pickControl(); if (cr) push(cr.id, 'handoff', { id: 'shift-' + S.now }, { title: `🔄 Shift handoff ${hhmm(S.now)}`, message: lines.join('\n'), priority: 3, tags: ['handoff'] });
    }

    // ---------- closing ----------
    function closeResolved(engine) {
      const live = new Set(engine.ongoing().map(e => e.event_id));
      for (const a of S.alerts.values()) if (!live.has(a.id) && a.state !== 'resolved') {
        a.state = 'resolved'; a.closed_at = S.now; log('close', 'model', a.id, `${a.category} resolved`);
        for (const jid of a.jobs || []) { const j = S.jobs.get(jid); if (j && j.state !== 'done') j.state = 'done'; }
        for (const tid of a.tasks || []) { const t = S.tasks.get(tid); if (t && t.state !== 'done') t.state = 'done'; }
        for (const q of S.queue.values()) if (q.alert_id === a.id && q.state === 'queued') { q.state = 'cancelled'; log('queue_cancel', 'system', q.id, 'pump recovered'); }
        for (const p of a.pinged || []) push(p, 'alert', a, { title: `✔ Resolved ${a.facility_id}`, message: `${a.category.replace('_', ' ')} is over.`, priority: 2, tags: ['resolved'] });
      }
    }

    // ---------- main tick ----------
    function tick(i, engine) {
      S.i = i; S.now = ds.tel.t0 + i * STEP;
      const A = M.alertsAt(ds, engine, i); // planned as if the whole fleet were free
      for (const s of ds.systems) {
        const items = A.failures.filter(f => f.ev.system_id === s.id); if (!items.length) continue;
        const fleet = ds.ops.systems[s.id].emergency_fleet_size, free = Math.max(0, fleet - trucksBusy(s.id));
        const pending = items.filter(f => { const a = S.alerts.get(f.ev.event_id); return !a || a.state === 'awaiting_approval' || a.state === 'no_action_needed'; });
        // Trucks already sent on approved plans are not available: re-plan the pending failures with what is left.
        const planned = free < fleet && pending.length ? M.planSystem(ds, pending, free) : pending;
        for (const f of items) { const p = planned.find(x => x.ev === f.ev); upsertFailure(p || f, free); }
      }
      for (const e of A.others) upsertOther(e, i);
      closeResolved(engine);
      timers();
    }

    // ---------- human actions ----------
    function act(token, action, actorOverride) {
      const tk = S.tokens.get(token); if (!tk) return { ok: false, error: 'unknown token' };
      const actor = actorOverride || tk.personId, p = S.people.get(actor);
      if (p) { p.lastHeartbeat = wallNow(); }
      if (tk.kind === 'alert') {
        const a = S.alerts.get(tk.refId); if (!a) return { ok: false, error: 'alert gone' };
        if (action === 'ack') { a.acked = true; a.next_ping_at = null; log('ack', actor, a.id, ''); return { ok: true, alert: view(a) }; }
        if (action === 'claim') {
          if (a.state === 'awaiting_approval') { approveBundle(a, actor); return { ok: true, result: 'approved', alert: view(a) }; }
          if (a.state === 'awaiting_claim') { a.state = 'claimed'; a.claimed_by = actor; a.acked = true; a.next_ping_at = null; a.escalate_at = null; log('claim', actor, a.id, 'inspector scheduled'); for (const q of a.pinged) if (q !== actor) push(q, 'alert', a, { title: `✅ Covered: ${a.facility_id}`, message: `${actor} has it. Stand down.`, priority: 2, tags: ['covered'] }); return { ok: true, result: 'claimed', alert: view(a) }; }
          return { ok: true, result: 'covered', alert: view(a), note: a.claimed_by ? `Covered by ${a.claimed_by}. Stand down.` : `Alert is ${a.state}.` };
        }
        if (action === 'decline') { log('decline', actor, a.id, ''); a.escalate_at = S.now; timers(); return { ok: true, result: 'declined', alert: view(a) }; }
      }
      if (tk.kind === 'job') {
        const j = S.jobs.get(tk.refId); if (!j) return { ok: false, error: 'job gone' };
        if (action === 'claim') {
          if (j.state !== 'open') return { ok: true, result: 'covered', job: j, note: 'Covered, stand down.' };
          if (j.claims.includes(actor)) return { ok: true, result: 'claimed', job: j };
          j.claims.push(actor); if (p) p.idleSince = S.now; log('claim', actor, j.id, `truck ${j.claims.length}/${j.trucks}`);
          if (j.claims.length >= j.trucks) { j.state = 'covered'; log('covered', 'system', j.id, j.claims.join(', ')); for (const q of j.pinged) if (!j.claims.includes(q)) push(q, 'job', j, { title: `✅ Covered: ${j.facility_id}`, message: `${j.claims.join(', ')} took it. Stand down.`, priority: 2, tags: ['covered'] }); }
          return { ok: true, result: 'claimed', job: j };
        }
        if (action === 'decline') { if (!j.declined.includes(actor)) j.declined.push(actor); log('decline', actor, j.id, ''); j.escalate_at = S.now; timers(); return { ok: true, result: 'declined', job: j }; }
        if (action === 'done') { j.state = 'done'; log('done', actor, j.id, ''); return { ok: true, result: 'done', job: j }; }
      }
      if (tk.kind === 'task') { const t = S.tasks.get(tk.refId); if (!t) return { ok: false, error: 'task gone' }; if (action === 'done' || action === 'claim') { t.state = 'done'; t.done_by = actor; log('task_done', actor, t.id, `wells ${t.wells.join(', ')} shut in`); } return { ok: true, result: 'done', task: t }; }
      if (tk.kind === 'queue') { const q = S.queue.get(tk.refId); if (!q) return { ok: false, error: 'gone' }; if (action === 'claim') { q.state = 'assigned'; q.owner = actor; log('claim', actor, q.id, 'inspection taken'); } if (action === 'done') { q.state = 'done'; log('done', actor, q.id, 'inspected'); const a = S.alerts.get(q.alert_id); if (a) a.state = 'inspected'; } return { ok: true, result: q.state, queue: q }; }
      return { ok: false, error: 'bad action' };
    }
    function heartbeat(token) { const tk = S.tokens.get(token); if (!tk) return false; const p = S.people.get(tk.personId); if (p) { const was = reachable(p); p.lastHeartbeat = wallNow(); if (!was) log('reachable', p.id, '', 'signal back'); } return true; }
    function setReachable(personId, on) { const p = S.people.get(personId); if (!p) return false; p.reachable = !!on; log('reachability', 'dashboard', personId, on ? 'reachable' : 'lost signal (simulated)'); if (!on) { for (const a of S.alerts.values()) if (['awaiting_approval', 'awaiting_claim'].includes(a.state) && a.pinged.includes(personId)) { a.escalate_at = S.now; } for (const j of S.jobs.values()) if (j.state === 'open' && j.pinged.includes(personId)) j.escalate_at = S.now; timers(); } return true; }
    // Virtual people: tokens the dashboard can act with.
    function tokensFor(personId) {
      const out = [];
      for (const a of S.alerts.values()) if ((a.pinged || []).includes(personId) && ['awaiting_approval', 'awaiting_claim'].includes(a.state)) out.push({ kind: 'alert', ref: a.id, token: tokenFor(personId, 'alert', a.id), label: `${a.category === 'pump_failure' ? 'Approve' : 'Claim'} ${a.facility_id}` });
      for (const j of S.jobs.values()) if (j.pinged.includes(personId) && j.state === 'open' && !j.claims.includes(personId)) out.push({ kind: 'job', ref: j.id, token: tokenFor(personId, 'job', j.id), label: `Truck ${j.facility_id}` });
      for (const t of S.tasks.values()) if (t.owner === personId && t.state === 'due') out.push({ kind: 'task', ref: t.id, token: tokenFor(personId, 'task', t.id), label: `Shut in ${t.wells.join(', ')}` });
      for (const q of S.queue.values()) if (q.state === 'queued' || q.owner === personId) { const insp = S.people.get(personId); if (insp && insp.role === 'inspector') out.push({ kind: 'queue', ref: q.id, token: tokenFor(personId, 'queue', q.id), label: `Inspect ${q.asset_id}` }); }
      return out;
    }

    // ---------- views ----------
    const waiting = () => cfg.pauseOnWait && ([...S.alerts.values()].some(a => ['awaiting_approval', 'awaiting_claim'].includes(a.state) && !a.acked) || [...S.jobs.values()].some(j => j.state === 'open' && j.claims.length < j.trucks && S.now < j.claim_by_unix) || [...S.tasks.values()].some(t => t.state === 'due'));
    function view(a) {
      const { ladder, do_nothing, fallback, approved_plan, plan, ...rest } = a;
      const lite = p => p && { label: p.label, cost: Math.round(p.cost), trucks: p.trucks, actions: p.actions };
      return { ...rest, plan: lite(plan), approved_plan: lite(approved_plan), fallback: lite(fallback), do_nothing_cost: do_nothing ? Math.round(do_nothing.cost) : null,
        approve_by_ts: a.approve_by_unix != null ? iso(a.approve_by_unix) : null, approve_by_first_ts: a.approve_by_first != null ? iso(a.approve_by_first) : null, minutes_to_approve: a.approve_by_unix != null ? Math.round((a.approve_by_unix - S.now) / 60) : null,
        ladder: (ladder || []).map(l => ({ atMin: l.atMin, cost: Math.round(l.cost), label: l.label })) };
    }
    function state() {
      const order = { critical: 0, high: 1, low: 2 };
      const alerts = [...S.alerts.values()].map(view).sort((a, b) => (a.state === 'resolved') - (b.state === 'resolved') || (a.category !== 'pump_failure') - (b.category !== 'pump_failure') || order[a.severity] - order[b.severity] || (a.hours_to_limit?.p50 ?? 1e9) - (b.hours_to_limit?.p50 ?? 1e9));
      const people = [...S.people.values()].map(p => ({ id: p.id, name: p.name || p.id, role: p.role, system: p.system || null, virtual: !!p.virtual, reachable: reachable(p), buzzed: p.buzzed, busy: busyDrivers().has(p.id), tokens: p.virtual ? tokensFor(p.id) : [] }));
      return { now: S.now, now_ts: iso(S.now), waiting: waiting(), alerts, people, jobs: [...S.jobs.values()].map(j => ({ ...j, claims: [...j.claims], pinged: [...j.pinged], declined: [...j.declined] })), tasks: [...S.tasks.values()].map(t => ({ ...t, due_ts: iso(t.due_unix) })), queue: [...S.queue.values()].map(q => ({ ...q, deadline_ts: iso(q.deadline_unix) })), bundles: [...S.bundles.values()], audit: S.audit.slice(-300), audit_total: S.audit.length, handoff: S.lastHandoff || null };
    }
    function forToken(token) {
      const tk = S.tokens.get(token); if (!tk) return null;
      const person = S.people.get(tk.personId);
      const base = { token, person: tk.personId, role: person?.role, kind: tk.kind, now_ts: iso(S.now) };
      if (tk.kind === 'alert') { const a = S.alerts.get(tk.refId); return a && { ...base, alert: view(a) }; }
      if (tk.kind === 'job') { const j = S.jobs.get(tk.refId); return j && { ...base, job: j, alert: S.alerts.has(j.alert_id) ? view(S.alerts.get(j.alert_id)) : null }; }
      if (tk.kind === 'task') { const t = S.tasks.get(tk.refId); return t && { ...base, task: { ...t, due_ts: iso(t.due_unix) } }; }
      if (tk.kind === 'queue') { const q = S.queue.get(tk.refId); return q && { ...base, queue: { ...q, deadline_ts: iso(q.deadline_unix) } }; }
      return base;
    }
    const setMuted = m => { S.muted = !!m; };
    const audit = () => S.audit;

    return { tick, act, heartbeat, setReachable, state, forToken, waiting, setMuted, audit, cfg, _S: S };
  }

  // People roster: control room, backup supervisor, inspector, and one driver per truck in each system.
  function defaultPeople(ds, roles = {}) {
    const out = [
      { id: 'control_room', name: 'Control room', role: 'control_room', virtual: false },
      { id: 'backup_supervisor', name: 'Backup supervisor', role: 'backup_supervisor', virtual: true },
      { id: 'inspector', name: 'Inspector', role: 'inspector', virtual: true },
    ];
    for (const s of ds.systems) { const n = ds.ops.systems[s.id].emergency_fleet_size; for (let k = 1; k <= n; k++) out.push({ id: `${s.id}_D${k}`, name: `${s.id} driver ${k}`, role: 'driver', system: s.id, virtual: true }); }
    for (const p of out) { const r = (roles.people || []).find(x => x.id === p.id); if (r) Object.assign(p, r); }
    return out;
  }

  const api = { createAlertEngine, defaultPeople, DEFAULTS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Alerts = api;
})(typeof window !== 'undefined' ? window : globalThis);
