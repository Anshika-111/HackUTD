// Planner stress test: random hard scenarios, our planner vs. an independent minute-by-minute brute force.
// Shared by the terminal (node app/stress.js [scenarios]) and the live console (window.Stress).
(function (root) {
  'use strict';
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const ops = { prices: { oil_per_bbl: 60, gas_per_mcf: 3 }, emergency_trucking: { truck_capacity_bbl: 150, cost_per_trip: 905 } };
  const ds = { lim: { shutdown: 92, warning: 85 }, ops };

  function rng(seed) { let s = seed; const r = () => (s = (s * 16807) % 2147483647) / 2147483647; return { r, pick: (a, b) => a + r() * (b - a), ipick: (a, b) => Math.floor(a + r() * (b - a + 1)) }; }

  // A real emergency: with no action the tank reaches shutdown somewhere in 5%–95% of the repair window.
  function scenario(R, id) {
    const cap = R.ipick(5, 20) * 100, nw = R.ipick(1, 4);
    const wells = Array.from({ length: nw }, (_, j) => ({ id: `W${j}`, bpd: R.pick(200, 1600), revPerHr: (R.pick(80, 700) * 60 + R.pick(300, 2500) * 3) / 24 }));
    const inflowBpd = wells.reduce((a, w) => a + w.bpd, 0), H = R.ipick(12, 72) * 5, tTrip = R.pick(0.05, 0.95) * H;
    const level = (0.92 * cap - inflowBpd / 1440 * tTrip) / cap * 100;
    if (level < 2) return scenario(R, id);
    return { fac: { id: 'F' + id, cap, resp: R.ipick(8, 24) * 5, cycle: R.ipick(30, 60) * 5 }, H, level, tripped: false,
      wells, inflowBpd, lostRevPerHr: wells.reduce((a, w) => a + w.revPerHr, 0) };
  }

  // Minute by minute: true if the tank never reaches shutdown before the repair. trace (optional) gets the level % each minute.
  function simSafe(sc, k, n, W, s, trace) {
    const lim = 0.92 * sc.fac.cap, rate = sc.inflowBpd / 1440, cut = W.reduce((a, w) => a + w.bpd, 0) / 1440;
    let v = sc.level / 100 * sc.fac.cap, trips = 0;
    for (let m = 1; m <= sc.H; m++) {
      v += rate - (m - 1 >= s ? cut : 0);
      if (v >= lim) { if (trace) trace.push(92); return false; }
      if (trips < n && m === sc.fac.resp + trips * sc.fac.cycle) { v -= Math.min(k * 150, v); trips++; }
      if (trace) trace.push(v / sc.fac.cap * 100);
    }
    return true;
  }
  // Cheapest over every plan with at most F trucks, or doing nothing.
  function brute(sc, F) {
    const lim = 0.92 * sc.fac.cap, V0 = sc.level / 100 * sc.fac.cap, tTrip = (lim - V0) / (sc.inflowBpd / 1440);
    let best = tTrip >= sc.H ? 0 : sc.lostRevPerHr * (sc.H - tTrip) / 60, checked = 0;
    const subsets = []; for (let m = 0; m < 1 << sc.wells.length; m++) subsets.push(sc.wells.filter((_, j) => m >> j & 1));
    for (let k = 0; k <= F; k++) for (let n = k ? 1 : 0; ; n++) {
      if (n > 0 && sc.fac.resp + (n - 1) * sc.fac.cycle >= sc.H) break; // every trip must arrive before the repair
      for (const W of subsets) {
        const rev = W.reduce((a, w) => a + w.revPerHr, 0);
        for (let s = sc.H; s >= 0; s--) { // latest safe start = cheapest for this (k, n, W)
          checked++;
          if (simSafe(sc, k, n, W, s)) { best = Math.min(best, k * n * 905 + rev * (sc.H - s) / 60); break; }
          if (!W.length) break;
        }
      }
      if (k === 0) break;
    }
    return { cost: best, checked };
  }

  // Deliberately worse plans, to show the test can fail: shut-ins start 15 min early (safe, but costs more).
  function sabotage(p, sc) {
    const sh = p.actions.find(a => a.type === 'shut_in_wells'); if (!sh || sh.start_after_min < 15) return p;
    const rev = sc.wells.filter(w => sh.wells.includes(w.id)).reduce((a, w) => a + w.revPerHr, 0);
    return { ...p, cost: p.cost + rev * 15 / 60, actions: p.actions.map(a => a === sh ? { ...a, start_after_min: a.start_after_min - 15 } : a), label: p.label + ' (sabotaged)' };
  }

  // Yields one result per case: N single-tank emergencies, then N/5 shared-fleet systems.
  function* cases(M, N, opts = {}) {
    const R = rng(opts.seed || 12345);
    for (let i = 0; i < N; i++) {
      const sc = scenario(R, i), F = R.ipick(0, 3);
      let t = now(); let p = M.planOne(ds, sc, F).best[F]; const tModel = now() - t;
      if (opts.sabotage) p = sabotage(p, sc);
      t = now(); const b = brute(sc, F); const tBrute = now() - t;
      const tr = p.actions.find(a => a.type === 'dispatch_truck'), sh = p.actions.find(a => a.type === 'shut_in_wells');
      const safe = p.actions[0].type === 'none' || simSafe(sc, tr ? tr.trucks : 0, tr ? tr.trips_per_truck : 0, sh ? sc.wells.filter(w => sh.wells.includes(w.id)) : [], sh ? sh.start_after_min : Infinity);
      const ok = safe && Math.abs(p.cost - b.cost) <= 0.01 && !(tr && tr.trucks > F);
      yield { kind: 'single', i, sc, F, plan: p, ours: p.cost, brute: b.cost, checked: b.checked, safe, ok, tModel, tBrute,
        type: tr && sh ? 'both' : tr ? 'trucks' : sh ? 'shut' : p.cost > 0 ? 'accept' : 'none' };
    }
    for (let i = 0; i < Math.round(N / 5); i++) {
      const items = Array.from({ length: R.ipick(2, 4) }, (_, j) => scenario(R, 1000 + i * 10 + j)), F = R.ipick(1, 3);
      let t = now(); const joint = M.planSystem(ds, items, F); const tModel = now() - t;
      const ours = joint.reduce((a, x) => a + (opts.sabotage ? sabotage(x.plan, x).cost : x.plan.cost), 0);
      t = now(); const tables = items.map(sc => Array.from({ length: F + 1 }, (_, k) => brute(sc, k).cost));
      let b = Infinity; (function rec(j, left, c) { if (j === items.length) return void (b = Math.min(b, c)); for (let k = 0; k <= left; k++) rec(j + 1, left - k, c + tables[j][k]); })(0, F, 0);
      const tBrute = now() - t;
      yield { kind: 'joint', i, items, F, joint, ours, brute: b, ok: Math.abs(ours - b) <= 0.01, tModel, tBrute };
    }
  }

  function summarize(results) {
    const s = results.filter(r => r.kind === 'single'), j = results.filter(r => r.kind === 'joint'), mix = {};
    for (const r of s) mix[r.type] = (mix[r.type] || 0) + 1;
    const avg = (a, k) => a.length ? a.reduce((x, r) => x + r[k], 0) / a.length : 0;
    return { singles: s.length, joints: j.length, bad: s.filter(r => !r.ok).length, jbad: j.filter(r => !r.ok).length,
      worst: Math.max(0, ...s.map(r => Math.abs(r.ours - r.brute))), mix, msModel: avg(s, 'tModel'), msBrute: avg(s, 'tBrute'), unsafe: s.filter(r => !r.safe).length };
  }

  const api = { cases, summarize, scenario, brute, simSafe };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    if (require.main === module) { // terminal run
      const M = require('./model.js'), N = +process.argv[2] || 300, sab = process.argv.includes('--sabotage');
      const res = [...cases(M, N, { sabotage: sab })], S = summarize(res);
      for (const r of res.filter(r => !r.ok).slice(0, 5)) console.log('MISMATCH', r.kind, Math.round(r.ours), 'vs brute', Math.round(r.brute), r.plan ? r.plan.label : '');
      console.log(`single-tank: ${S.singles} random emergencies · ${S.bad} mismatches · worst cost gap $${S.worst.toFixed(2)} · plans: ${JSON.stringify(S.mix)}`);
      console.log(`shared fleet: ${S.joints} random systems (2–4 failing tanks, 1–3 trucks) · ${S.jbad} mismatches`);
      console.log(`speed: our planner ${(S.msModel * 1000).toFixed(0)} µs/scenario vs brute force ${S.msBrute.toFixed(1)} ms/scenario`);
      console.log(S.bad + S.jbad ? 'STRESS TEST FAILED' : 'STRESS TEST PASSED');
      process.exitCode = S.bad + S.jbad ? 1 : 0;
    }
  } else root.Stress = api;
})(typeof window !== 'undefined' ? window : globalThis);
