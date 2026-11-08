// node app/check.js <dataset-folder>...  Scores detection + plan cost against answer_key.json.
const fs = require('fs'), path = require('path'), M = require('./model.js');
const money = s => { const m = /~\$([\d,]+)/.exec(s); return m ? +m[1].replace(/,/g, '') : (/^none/.test(s) ? 0 : null); };
let fail = 0;
for (const dir of process.argv.slice(2)) {
  const rd = f => fs.readFileSync(path.join(dir, f), 'utf8');
  const t = process.hrtime.bigint();
  const ds = M.loadDataset(JSON.parse(rd('network.json')), JSON.parse(rd('ops.json')), rd('telemetry.csv'));
  const tParse = Number(process.hrtime.bigint() - t) / 1e6;
  const t2 = process.hrtime.bigint();
  const R = M.weekReplay(ds), eng = R.engine;
  const tRun = Number(process.hrtime.bigint() - t2) / 1e6;
  const last = ds.tel.n - 1, alerts = M.alertsAt(ds, eng, last);
  console.log(`\n== ${dir}  rows=${ds.tel.rows} parse=${tParse.toFixed(0)}ms  detect ${ds.tel.n} ticks=${tRun.toFixed(1)}ms (${(tRun * 1000 / ds.tel.n).toFixed(1)}µs/tick)`);
  const keyFile = path.join(dir, 'answer_key.json');
  if (!fs.existsSync(keyFile)) { console.log('no answer key; ongoing:', eng.ongoing().map(e => `${e.category}@${e.facility_id}`).join(' ')); continue; }
  const key = JSON.parse(rd('answer_key.json'));
  const used = new Set(); let savedRef = 0, savedUs = 0, dn = 0;
  for (const a of key) {
    const m = eng.events.find(e => !used.has(e) && e.facility_id === a.facility && e.category === a.category && Math.abs(e.onset_unix - a.onset_unix) < 6 * 3600);
    if (m) used.add(m);
    const lag = m ? ((m.detected_unix - a.onset_unix) / 60).toFixed(0) : '-';
    let planTxt = '';
    if (a.category === 'pump_failure' && m) {
      const ref = money(a.reference_action);
      const ongoing = a.status === 'ongoing';
      const ours = ongoing ? alerts.failures.find(f => f.ev === m) : null;
      const plan = ongoing ? ours.plan : R.plans.get(m.event_id).plan;
      const ok = ref == null || Math.abs(plan.cost - ref) <= Math.max(25, ref * 0.03);
      if (!ok) fail++;
      if (!ongoing) { const d = R.plans.get(m.event_id).doNothing.cost; dn += d; savedUs += d - plan.cost; savedRef += d - (ref ?? 0); }
      planTxt = `${ok ? 'OK ' : 'BAD'} ours $${Math.round(plan.cost)} vs ref $${ref}  [${plan.label}]` + (ongoing ? `  h_to_limit ${ours.hours_to_limit.p50} (ref ${a.hours_to_limit_final})` : '');
    }
    if (!m) fail++;
    const endErr = m && a.end_unix && m.end_unix ? ((m.end_unix - a.end_unix) / 60).toFixed(0) + 'm' : (a.status === 'ongoing' && m?.status === 'ongoing' ? 'ongoing' : '?');
    console.log(`${a.id.padEnd(9)}${a.category.padEnd(17)}${a.facility.padEnd(15)}${m ? 'found' : 'MISSED'} detect+${lag}min onsetErr ${m ? ((m.onset_unix - a.onset_unix) / 60).toFixed(0) : '-'}m end ${endErr} conf ${m?.confidence ?? '-'} ${planTxt}`);
  }
  const fp = eng.events.filter(e => !used.has(e));
  if (fp.length) { fail += fp.length; console.log('FALSE POSITIVES:', fp.map(e => `${e.category}@${e.facility_id} ${e.onset_ts}`).join('; ')); }
  if (dir.endsWith('full_week')) {
    const mv = M.maintenanceValue(R), fl = M.fleetWhatIf(ds), rb = M.rebalance(fl);
    console.log('maintenance:', mv.map(m => `${m.asset} warned ${m.warnedHours.toFixed(0)}h ahead, plan $${Math.round(m.planCost)}`).join('; '));
    console.log('rebalance:', rb.moves.map(m => `${m.from}->${m.to} saves $${Math.round(m.gain)}/wk`).join('; '));
    if (mv.length !== 3) { fail++; console.log('BAD: expected 3 wear->failure links'); }
    for (const m of rb.moves) if (fl[m.from].costs[rb.size[m.from]] - fl[m.from].costs[fl[m.from].now] > 1) { fail++; console.log('BAD: rebalance hurt', m.from); }
  }
  if (dn) console.log(`do-nothing cost $${Math.round(dn)} | our plans save $${Math.round(savedUs)} | reference saves $${Math.round(savedRef)}`);
}
console.log(fail ? `\n${fail} problem(s)` : '\nALL CHECKS PASS');
process.exitCode = fail ? 1 : 0;
