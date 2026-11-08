// Beat the Shutdown: streaming detector + countdown + cheapest-plan optimizer.
// Pure JS, no deps. Same file runs in the browser (window.Model) and Node (require).
(function (root) {
  'use strict';
  const STEP = 300; // telemetry grid, seconds

  // Calibration learned from history/full_week healthy periods (not per-dataset data).
  // Default noise levels (measured on history/full_week). Each facility re-measures its own from the data (noiseOf).
  const CAL = {
    pressSigma: 3,      // psi, healthy std of pipeline & discharge pressure
    flowSigma: 0.0064,  // healthy std of flow / max_flow_bpd
    leakK: 2, leakH: 10,   // CUSUM slack / alarm, in sigmas (pipeline pressure deficit)
    wearK: 1, wearH: 15,   // CUSUM slack / alarm, in sigmas (flow + discharge deficit)
    clearN: 6,             // running samples back to normal before an event closes
  };

  // ---------- parsing ----------
  function parseTelemetry(text) {
    const lines = text.split('\n');
    let t0 = Infinity, t1 = -Infinity;
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i]; if (!l) continue;
      const a = l.indexOf(','), b = l.indexOf(',', a + 1);
      const t = +l.slice(a + 1, b);
      if (t < t0) t0 = t; if (t > t1) t1 = t;
    }
    if (!isFinite(t0)) throw new Error('telemetry.csv has no rows');
    const n = (t1 - t0) / STEP + 1;
    const series = new Map();
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i]; if (!l) continue;
      const a = l.indexOf(','), b = l.indexOf(',', a + 1), c = l.indexOf(',', b + 1), d = l.indexOf(',', c + 1);
      const key = l.slice(b + 1, d);
      let arr = series.get(key);
      if (!arr) { arr = new Float64Array(n).fill(NaN); series.set(key, arr); }
      arr[(+l.slice(a + 1, b) - t0) / STEP] = +l.slice(d + 1);
    }
    return { t0, t1, n, rows: lines.length - 1, series };
  }
  // series key is asset_id + ',' + metric
  const k = (asset, metric) => asset + ',' + metric;

  function loadDataset(network, ops, telemetryText) {
    const tel = parseTelemetry(telemetryText);
    const lim = network.defaults.tank_limits_pct;
    const facs = [];
    for (const s of network.systems) {
      const so = ops.systems[s.id];
      for (const f of s.facilities) {
        const fo = so.facilities[f.id];
        const get = (asset, m) => tel.series.get(k(asset, m)) || new Float64Array(tel.n).fill(NaN);
        facs.push({
          id: f.id, sys: s.id, lat: f.lat, lon: f.lon, f, fleet: so.emergency_fleet_size,
          resp: fo.response_min, cycle: fo.cycle_min, disp: s.disposal_site.pressure_psi,
          cap: f.tank.capacity_bbl, maxFlow: f.pump.max_flow_bpd,
          wells: f.wells.map(w => ({ id: w.id, revPerHr: (w.oil_bpd * ops.prices.oil_per_bbl + w.gas_mcfd * ops.prices.gas_per_mcf) / 24, water: get(w.id, 'water_bpd'), base: w.baseline_water_bpd })),
          s: {
            level: get(f.tank.id, 'level_pct'), inflow: get(f.id, 'inflow_bpd'),
            pst: get(f.pump.id, 'status'), flow: get(f.pump.id, 'flow_bpd'), dpsi: get(f.pump.id, 'discharge_psi'),
            recv: get(f.pipeline.id, 'receive_flow_bpd'), ppsi: get(f.pipeline.id, 'pressure_psi'),
          },
        });
      }
    }
    for (const f of facs) f.noise = noiseOf(f, tel.n);
    return { network, ops, tel, lim, facs, systems: network.systems };
  }

  // Each sensor's own noise, from its first day of pumping: median |change between readings| x 1.4826 / sqrt2.
  // Differences cancel the baseline, and the median ignores the odd jump, so a leak or worn pump starting
  // in that window barely moves it. Floor at half the default so a very clean sensor can't make alarms twitchy.
  function noiseOf(fac, n) {
    const end = Math.min(n, 288), dp = [], dd = [], df = [], S = fac.s;
    for (let i = 1; i < end; i++) if (S.pst[i] === 1 && S.pst[i - 1] === 1) {
      dp.push(Math.abs(S.ppsi[i] - S.ppsi[i - 1])); dd.push(Math.abs(S.dpsi[i] - S.dpsi[i - 1])); df.push(Math.abs(S.flow[i] - S.flow[i - 1]) / fac.maxFlow);
    }
    const med = a => { const b = a.filter(Number.isFinite).sort((x, y) => x - y); return b.length ? b[b.length >> 1] : NaN; };
    const sig = (a, def) => { const m = med(a); return a.length >= 24 && m > 0 ? Math.max(def * 0.5, m * 1.4826 / Math.SQRT2) : def; };
    return { p: sig(dp, CAL.pressSigma), d: sig(dd, CAL.pressSigma), f: sig(df, CAL.flowSigma), samples: dp.length };
  }

  // ---------- streaming detector ----------
  // O(facilities) work per 5-minute tick, constant memory per facility.
  function createEngine(ds) {
    const events = []; let seq = 0;
    const st = ds.facs.map(() => ({
      leak: { S: 0, zeroAt: 0, ev: null, clear: 0, lost: 0 },
      wear: { S: 0, zeroAt: 0, ev: null, clear: 0 },
      fail: { ev: null },
    }));
    const iso = t => new Date(t * 1000).toISOString().replace('.000', '');
    function open(fac, cat, asset, onsetI, i, evidence) {
      const t = ds.tel.t0 + onsetI * STEP;
      const ev = { event_id: 'EV-' + String(++seq).padStart(4, '0'), system_id: fac.sys, facility_id: fac.id, asset_id: asset,
        category: cat, status: 'ongoing', onset_ts: iso(t), onset_unix: t, end_ts: null, end_unix: null,
        detected_unix: ds.tel.t0 + i * STEP, confidence: 0, evidence };
      events.push(ev); return ev;
    }
    function close(ev, i) { const t = ds.tel.t0 + i * STEP; ev.status = 'resolved'; ev.end_unix = t; ev.end_ts = iso(t); }

    function step(i) {
      ds.facs.forEach((fac, fi) => {
        const S = fac.s, x = st[fi], pst = S.pst[i];
        // 1) Pump failure: fault code is direct evidence.
        if (pst === 2 && !x.fail.ev) {
          if (x.wear.ev) { close(x.wear.ev, i); x.wear.ev = null; x.wear.S = 0; } // worn pump that fails = two events
          x.fail.ev = open(fac, 'pump_failure', fac.f.pump.id, i, i, ['Pump reports fault (status 2)', 'Tank level rising with no outflow']);
          x.fail.ev.confidence = 0.99;
        } else if (pst !== 2 && x.fail.ev) { close(x.fail.ev, i); x.fail.ev = null; }
        if (pst !== 1) return; // leak/wear only observable while pumping

        // 2) Leak: pipeline pressure below healthy (disposal + 50), water missing at the far end.
        const pdef = (fac.disp + 50 - S.ppsi[i]) / fac.noise.p;
        const gap = S.flow[i] - S.recv[i];
        const L = x.leak;
        const l0 = L.S; L.S = Math.max(0, L.S + pdef - CAL.leakK);
        if (l0 === 0 && L.S > 0) L.zeroAt = i; // first abnormal running sample = onset estimate
        if (!L.ev && L.S > CAL.leakH) L.ev = open(fac, 'pipeline_leak', fac.f.pipeline.id, L.zeroAt, i, []);
        if (L.ev) {
          L.lost += Math.max(0, gap) * STEP / 86400;
          L.ev.confidence = +(1 - Math.exp(-L.S / CAL.leakH)).toFixed(2);
          L.ev.leak_bpd = Math.round(gap); L.ev.lost_bbl = Math.round(L.lost);
          L.ev.evidence = [`Pipeline pressure ${Math.round(pdef * fac.noise.p)} psi below healthy`, `${Math.round(gap)} bpd pumped but not received`, `~${Math.round(L.lost)} bbl lost so far`];
          L.clear = pdef < CAL.leakK ? L.clear + 1 : 0;
          if (L.clear >= CAL.clearN) { close(L.ev, i - CAL.clearN + 1); L.ev = null; L.S = 0; L.lost = 0; }
        }
        // 3) Worn pump: flow below max_flow_bpd AND discharge pressure sagging, no flow gap.
        const health = S.flow[i] / fac.maxFlow;
        const z = ((1 - health) / fac.noise.f + (fac.disp + 150 - S.dpsi[i]) / fac.noise.d) / 2;
        const W = x.wear;
        const w0 = W.S; W.S = Math.max(0, W.S + z - CAL.wearK);
        if (w0 === 0 && W.S > 0) W.zeroAt = i;
        if (!W.ev && W.S > CAL.wearH) {
          const tr = healthTrend(fac, i); // back-date onset to where the trend line left 100%
          const back = tr.loss_pct_per_hr > 0.05 ? Math.round((100 - tr.health_pct) / tr.loss_pct_per_hr * 12) : 0;
          W.ev = open(fac, 'pump_degradation', fac.f.pump.id, Math.max(0, Math.min(W.zeroAt, i - Math.min(back, 144))), i, []);
        }
        if (W.ev) {
          W.ev.confidence = +(1 - Math.exp(-W.S / CAL.wearH)).toFixed(2);
          const tr = healthTrend(fac, i);
          Object.assign(W.ev, tr);
          W.ev.evidence = [`Pump at ${tr.health_pct}% of rated flow`, `Losing ${tr.loss_pct_per_hr}%/hr`, tr.hours_to_80 != null ? `Reaches 80% in ~${tr.hours_to_80} h` : 'Trend flat'];
          W.clear = z < CAL.wearK ? W.clear + 1 : 0;
          if (W.clear >= CAL.clearN) { close(W.ev, i - CAL.clearN + 1); W.ev = null; W.S = 0; }
        }
      });
    }
    // Pre-alarm suspicion (0..1 = fraction of the alarm threshold): the early-warning watch list.
    const scores = () => ds.facs.map((f, fi) => ({ id: f.id, leak: Math.min(1, st[fi].leak.S / CAL.leakH), wear: Math.min(1, st[fi].wear.S / CAL.wearH) }));
    return { step, events, scores, ongoing: () => events.filter(e => e.status === 'ongoing') };
  }

  // Least-squares slope of y over x.
  function fit(xs, ys) {
    const n = xs.length; if (n < 3) return null;
    let mx = 0, my = 0; for (let j = 0; j < n; j++) { mx += xs[j]; my += ys[j]; } mx /= n; my /= n;
    let sxx = 0, sxy = 0; for (let j = 0; j < n; j++) { sxx += (xs[j] - mx) ** 2; sxy += (xs[j] - mx) * (ys[j] - my); }
    const b = sxy / sxx, a = my - b * mx;
    let r = 0; for (let j = 0; j < n; j++) r += (ys[j] - a - b * xs[j]) ** 2;
    return { a, b, se: Math.sqrt(r / Math.max(1, n - 2) / sxx), at: x => a + b * x };
  }

  // Pump health forecast: linear trend over last 6 h of running samples.
  function healthTrend(fac, i) {
    const xs = [], ys = [];
    for (let j = Math.max(0, i - 72); j <= i; j++) if (fac.s.pst[j] === 1) { xs.push(j / 12); ys.push(100 * fac.s.flow[j] / fac.maxFlow); }
    const f = fit(xs, ys);
    const now = f ? f.at(i / 12) : ys[ys.length - 1];
    const slope = f ? f.b : 0;
    return { health_pct: +now.toFixed(1), loss_pct_per_hr: +(-slope).toFixed(2),
      hours_to_80: slope < -0.01 && now > 80 ? +((now - 80) / -slope).toFixed(1) : null };
  }

  // ---------- pump-failure state at tick i ----------
  function failureState(ds, ev, i) {
    const fac = ds.facs.find(f => f.id === ev.facility_id);
    const repairH = ds.ops.expected_repair_hours.pump_failure;
    const onsetI = (ev.onset_unix - ds.tel.t0) / STEP;
    const H = Math.max(0, (onsetI + repairH * 12 - i) * 5); // minutes of repair left
    const lo = Math.max(onsetI, i - 11);
    const xs = [], ys = []; for (let j = lo; j <= i; j++) { xs.push(j); ys.push(fac.s.level[j]); }
    const f = fit(xs, ys);
    const level = f ? Math.min(f.at(i), Math.max(...ys)) : fac.s.level[i];
    const tripped = fac.s.inflow[i] === 0 && fac.s.level[i] >= ds.lim.shutdown - 0.5;
    // live per-well water: mean of last hour while producing (smooths sensor noise)
    const wells = fac.wells.map(w => {
      let s = 0, c = 0; for (let j = Math.max(0, i - 11); j <= i; j++) if (w.water[j] > 0) { s += w.water[j]; c++; }
      return { id: w.id, revPerHr: w.revPerHr, bpd: c ? s / c : (tripped ? w.base : 0) };
    });
    const inflowBpd = wells.reduce((a, w) => a + w.bpd, 0);
    const ratePct = inflowBpd / 24 / fac.cap * 100; // %/hr
    const left = ds.lim.shutdown - level;
    let p50 = tripped ? 0 : ratePct > 0 ? left / ratePct : null, p10 = p50, p90 = p50;
    if (!tripped && f && f.b > 0) { // slope band from the level fit, per 5 min -> per hr
      const hi = (f.b + 1.28 * f.se) * 12, lw = Math.max(1e-6, (f.b - 1.28 * f.se) * 12);
      p10 = Math.min(p50, left / hi); p90 = Math.max(p50, left / lw);
    }
    const r = v => v == null ? null : +Math.max(0, v).toFixed(2);
    return { fac, H, level, tripped, wells, inflowBpd, ratePct,
      hours_to_limit: p50 == null ? null : { p10: r(p10), p50: r(p50), p90: r(p90) },
      lostRevPerHr: fac.wells.reduce((a, w) => a + w.revPerHr, 0) };
  }

  // ---------- planner ----------
  // Does a plan keep the tank under shutdown until the repair ends? Exact piecewise-linear check:
  // between events volume only rises, so checking just before each truck arrival and at H is enough.
  function safe(V0, lim, ratePerMin, H, arrivals, removeBbl, cutRate, s) {
    const pts = [...arrivals.map(t => [t, 'a']), [H, 'h']]; if (s > 0 && s < H) pts.push([s, 's']);
    pts.sort((a, b) => a[0] - b[0]);
    let v = V0, t = 0, rate = s <= 0 ? ratePerMin - cutRate : ratePerMin;
    for (const [tp, kind] of pts) {
      v += rate * (tp - t); t = tp;
      if (v >= lim) return false;
      if (kind === 'a') v -= Math.min(removeBbl, v);
      else if (kind === 's') rate = ratePerMin - cutRate;
    }
    return true;
  }

  // All non-dominated plans for one failure, best cost for each truck count 0..maxTrucks.
  // trace (optional array) receives every candidate plan checked, for the story visual.
  function planOne(ds, fsx, maxTrucks, trace) {
    const { fac, H, level, tripped, wells, inflowBpd } = fsx;
    const cap = ds.ops.emergency_trucking.truck_capacity_bbl, price = ds.ops.emergency_trucking.cost_per_trip;
    const lim = ds.lim.shutdown / 100 * fac.cap, V0 = level / 100 * fac.cap, rate = inflowBpd / 1440;
    const tTrip = rate > 0 ? (lim - V0) / rate : Infinity;
    const doNothing = tripped ? { cost: fsx.lostRevPerHr * H / 60, label: 'Already shut in; wait for repair' }
      : tTrip >= H ? { cost: 0, label: 'No action: tank peaks below shutdown before repair' }
      : { cost: fsx.lostRevPerHr * (H - tTrip) / 60, label: `Do nothing: trips in ${(tTrip / 60).toFixed(1)} h` };
    doNothing.trucks = 0; doNothing.actions = [{ type: 'none' }]; doNothing.tripMin = tTrip;
    const best = Array.from({ length: maxTrucks + 1 }, () => doNothing);
    if (tripped || tTrip >= H) return { best, doNothing };

    const subsets = [];
    for (let m = 0; m < 1 << wells.length; m++) subsets.push(wells.filter((_, j) => m >> j & 1));
    for (let kT = 0; kT <= maxTrucks; kT++) {
      const maxTrips = kT === 0 ? 0 : Math.max(0, Math.floor((H - 1 - fac.resp) / fac.cycle) + 1);
      for (let n = kT === 0 ? 0 : 1; n <= maxTrips; n++) {
        const arr = Array.from({ length: n }, (_, j) => fac.resp + j * fac.cycle);
        for (const W of subsets) {
          const cut = W.reduce((a, w) => a + w.bpd, 0) / 1440, rev = W.reduce((a, w) => a + w.revPerHr, 0);
          if (!safe(V0, lim, rate, H, arr, kT * cap, cut, 0)) { if (trace) trace.push({ kT, n, wells: W.map(w => w.id), ok: false }); continue; }
          let s = 0, hi = Math.floor(H); // latest feasible shut-in start (monotone) by binary search
          if (W.length === 0) s = H;
          else while (s < hi) { const m = (s + hi + 1) >> 1; if (safe(V0, lim, rate, H, arr, kT * cap, cut, m)) s = m; else hi = m - 1; }
          const cost = kT * n * price + rev * (H - s) / 60;
          if (trace) trace.push({ kT, n, wells: W.map(w => w.id), ok: true, s, cost });
          if (cost < best[kT].cost - 1e-9) {
            const actions = [];
            if (kT) actions.push({ type: 'dispatch_truck', facility_id: fac.id, trucks: kT, trips_per_truck: n });
            if (W.length) actions.push({ type: 'shut_in_wells', wells: W.map(w => w.id), start_after_min: s });
            best[kT] = { cost, trucks: kT, trips: n, busyMin: kT ? fac.resp + (n - 1) * fac.cycle + fac.cycle : 0, actions,
              label: [kT && `${kT} truck${kT > 1 ? 's' : ''}, ${n} trip${n > 1 ? 's' : ''} each`, W.length && `shut in ${W.map(w => w.id).join(', ')} at +${s} min`].filter(Boolean).join(' + ') };
          }
        }
      }
      if (kT > 0 && best[kT].cost > best[kT - 1].cost) best[kT] = best[kT - 1]; // more trucks never forced
    }
    return { best, doNothing };
  }

  // Joint plan for every ongoing failure in a system: they share the fleet (brute force allocation).
  function planSystem(ds, items, freeTrucks) {
    const tables = items.map(it => planOne(ds, it, freeTrucks));
    let bestAlloc = null, bestCost = Infinity;
    (function rec(j, left, alloc, cost) {
      if (j === items.length) { if (cost < bestCost - 1e-9) { bestCost = cost; bestAlloc = alloc.slice(); } return; }
      for (let t = 0; t <= left; t++) { alloc.push(t); rec(j + 1, left - t, alloc, cost + tables[j].best[t].cost); alloc.pop(); }
    })(0, freeTrucks, [], 0);
    return items.map((it, j) => ({ ...it, plan: tables[j].best[bestAlloc[j]], doNothing: tables[j].doNothing,
      alternatives: tables[j].best }));
  }

  // "Plan from now" across all systems, fleet fully free (nothing dispatched in the recording).
  function alertsAt(ds, engine, i) {
    const on = engine.ongoing();
    const fails = on.filter(e => e.category === 'pump_failure').map(e => ({ ev: e, ...failureState(ds, e, i) }));
    const out = [];
    for (const s of ds.systems) {
      const items = fails.filter(f => f.fac.sys === s.id); if (!items.length) continue;
      out.push(...planSystem(ds, items, ds.ops.systems[s.id].emergency_fleet_size));
    }
    out.sort((a, b) => (a.hours_to_limit?.p50 ?? 1e9) - (b.hours_to_limit?.p50 ?? 1e9) || b.lostRevPerHr - a.lostRevPerHr);
    return { failures: out, others: on.filter(e => e.category !== 'pump_failure') };
  }

  // Replay the recording tick by tick, planning each failure at its onset; trucks sent earlier stay busy
  // (how full_week/answer_key.json reference_action is defined).
  function createReplay(ds) {
    const engine = createEngine(ds), busy = {}, plans = new Map();
    function step(i) {
      const before = engine.events.length; engine.step(i);
      for (const e of engine.events.slice(before)) if (e.category === 'pump_failure') {
        const now = ds.tel.t0 + i * STEP;
        const b = (busy[e.system_id] || []).filter(u => u.until > now); busy[e.system_id] = b;
        const fsx = failureState(ds, e, i);
        const t = planOne(ds, fsx, ds.ops.systems[e.system_id].emergency_fleet_size - b.length);
        const plan = t.best[t.best.length - 1];
        for (let j = 0; j < plan.trucks; j++) b.push({ until: now + plan.busyMin * 60, facility: e.facility_id });
        plans.set(e.event_id, { plan, doNothing: t.doNothing, freeTrucks: t.best.length - 1 });
      }
    }
    function totals() {
      let dn = 0, cost = 0; for (const p of plans.values()) { dn += p.doNothing.cost; cost += p.plan.cost; }
      return { doNothingCost: dn, planCost: cost, saved: dn - cost };
    }
    return { engine, plans, busy, step, totals };
  }
  function weekReplay(ds, upTo = ds.tel.n - 1) {
    const r = createReplay(ds); for (let i = 0; i <= upTo; i++) r.step(i);
    return Object.assign(r, r.totals());
  }

  // ---------- savings beyond the single-event plan ----------
  // Predictive maintenance: a worn-pump alert that is still open when the same pump fails.
  // Assumption (not in the data): repairing the pump during the warning prevents the failure.
  function maintenanceValue(R) {
    const ev = R.engine.events, out = [];
    for (const f of ev) if (f.category === 'pump_failure') {
      const w = ev.find(e => e.category === 'pump_degradation' && e.asset_id === f.asset_id && e.detected_unix < f.onset_unix && Math.abs((e.end_unix ?? f.onset_unix) - f.onset_unix) <= 600);
      const p = R.plans.get(f.event_id);
      if (w && p) out.push({ asset: f.asset_id, facility: f.facility_id, warnedHours: (f.onset_unix - w.detected_unix) / 3600, planCost: p.plan.cost, doNothingCost: p.doNothing.cost, failure: f, wear: w });
    }
    return out;
  }
  // Fleet what-if: this system's plan cost for the week with 0..fleet+extra trucks (ops changed, data reused).
  function fleetWhatIf(ds, extra = 2) {
    const table = {};
    for (const s of ds.systems) {
      const now = ds.ops.systems[s.id].emergency_fleet_size, costs = [];
      for (let n = 0; n <= now + extra; n++) {
        const ops = JSON.parse(JSON.stringify(ds.ops)); ops.systems[s.id].emergency_fleet_size = n;
        const r = weekReplay({ ...ds, ops });
        let c = 0; for (const [id, p] of r.plans) if (r.engine.events.find(e => e.event_id === id).system_id === s.id) c += p.plan.cost;
        costs.push(c);
      }
      table[s.id] = { now, costs };
    }
    return table;
  }
  // Move trucks from where they are idle to where they save most; total fleet unchanged. Greedy, one truck at a time.
  function rebalance(table) {
    const size = Object.fromEntries(Object.entries(table).map(([k, v]) => [k, v.now])), moves = [];
    const cost = (k, n) => table[k].costs[Math.min(n, table[k].costs.length - 1)];
    for (;;) {
      let best = null;
      for (const from in size) if (size[from] > 0) for (const to in size) if (to !== from && size[to] + 1 < table[to].costs.length) {
        const gain = (cost(to, size[to]) - cost(to, size[to] + 1)) - (cost(from, size[from] - 1) - cost(from, size[from]));
        if (gain > 1 && (!best || gain > best.gain)) best = { from, to, gain };
      }
      if (!best) return { moves, size };
      size[best.from]--; size[best.to]++; moves.push(best);
    }
  }

  // ---------- approve-by deadline ----------
  // How long can the call wait before the cheapest plan stops working? Project the tank forward from the
  // current estimates (no peeking at future telemetry): every 5 min the level rises by ratePct/12 and the
  // repair window H shrinks by 5 min. The deadline is the last start time where the same plan (same trucks,
  // trips and wells) is still feasible. Past it, the planner's next-cheapest plan is the fallback.
  // Also returns a ladder (cost of acting at each later start) for the "money burning" display.
  function approveBy(ds, fsx0, maxTrucks) {
    const same = (a, b) => a.trucks === b.trucks && (a.trips || 0) === (b.trips || 0)
      && JSON.stringify((a.actions.find(x => x.type === 'shut_in_wells') || {}).wells || []) === JSON.stringify((b.actions.find(x => x.type === 'shut_in_wells') || {}).wells || []);
    const t0 = planOne(ds, fsx0, maxTrucks), P0 = t0.best[maxTrucks];
    const out = { plan: P0, deadlineMin: null, fallback: null, costIfMissed: 0, ladder: [{ atMin: 0, cost: P0.cost, label: P0.label }] };
    if (fsx0.tripped || P0 === t0.doNothing) return out; // nothing to approve
    let k = 0, last = P0;
    for (k = 1; k * 5 < fsx0.H; k++) {
      const fs = { ...fsx0, level: fsx0.level + fsx0.ratePct * k * 5 / 60, H: fsx0.H - k * 5 };
      const t = planOne(ds, fs, maxTrucks), P = t.best[maxTrucks];
      if (k % 6 === 0 || !same(P, P0)) out.ladder.push({ atMin: k * 5, cost: P.cost, label: P.label });
      if (!same(P, P0)) { out.fallback = P; break; }
      last = P;
    }
    out.deadlineMin = (k - 1) * 5;            // last 5-min tick where the plan still works
    if (!out.fallback) out.fallback = last;    // plan held until the repair ends
    out.costIfMissed = Math.max(0, out.fallback.cost - P0.cost);
    out.truckPossible = t0.best.some(p => p.trucks > 0);
    return out;
  }

  // Export shape from SPEC.md events.json
  function exportEvents(ds, engine, i) {
    const a = alertsAt(ds, engine, i), byId = new Map(a.failures.map(f => [f.ev.event_id, f]));
    return engine.events.map(e => {
      const f = byId.get(e.event_id);
      const { leak_bpd, lost_bbl, health_pct, loss_pct_per_hr, hours_to_80, detected_unix, ...base } = e;
      return { ...base, level_pct: f ? +f.level.toFixed(1) : null, hours_to_limit: f ? f.hours_to_limit : null,
        recommended_actions: e.category === 'pump_failure' ? (f ? f.plan.actions : [{ type: 'none' }]) : [{ type: 'field_inspection', asset_id: e.asset_id }],
        est_cost: f ? Math.round(f.plan.cost) : null };
    });
  }

  const api = { STEP, CAL, parseTelemetry, loadDataset, noiseOf, createEngine, failureState, planOne, planSystem, approveBy, alertsAt, exportEvents, createReplay, weekReplay, maintenanceValue, fleetWhatIf, rebalance };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.Model = api;
})(typeof window !== 'undefined' ? window : globalThis);
