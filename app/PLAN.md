# Glass Box: prediction model plan (Beat the Shutdown)

Pitch: **"We predict the failure, dispatch the cheapest fix, and show every decision, all in under a millisecond, for less than a cent a year."**

Every number below was measured with `node app/check.js` against the answer keys in `HackUTD-ZeroDay/history/`.

## 1. Why not a big ML model

| | Deep learning (LSTM / autoencoder) | Our model (physics + statistics) |
|---|---|---|
| Training data | Needs many examples. There are only **23 labelled events** | Needs none. Healthy values come from `network.json` (rated flow, disposal pressure) |
| Unseen test network (S6–S11) | Has to generalise from S1–S5, which is risky | Works because it reads each network's own ratings |
| Hardware | GPU or cloud server | Runs in a browser tab, even on a phone |
| Explainability | Black box | Every alert lists its evidence in plain English (the "glass box") |
| Speed | Tens of ms per inference plus server round-trip | **~3 µs per 5-minute tick for the whole network** |

The judges score detection accuracy, how close plans are to the cheapest, and "no hardcoding". A small physics-based model wins on all three.

## 2. What the data says (measured on full_week)

| Problem | Signal | Healthy noise | Size at onset | Grows to |
|---|---|---|---|---|
| Pump failure | pump `status = 2`, tank rises in a straight line | n/a | immediate | tank +9 %/h |
| Pipeline leak | pipeline `pressure_psi` below disposal + 50 | σ = 3 psi | −15 psi (5σ) in hour 1 | −60 psi |
| | `flow_bpd − receive_flow_bpd` | ≈ 0 | 40–60 bpd | 200–270 bpd |
| Worn pump | `flow_bpd ÷ max_flow_bpd` while running | σ = 0.64 % | −0.4 %/h ramp | −12 % |
| | `discharge_psi` below disposal + 150 | σ = 3 psi | −1 psi/h drift | −30 psi |

Leaks don't change discharge pressure or pump flow. Worn pumps don't open a flow gap or lower pipeline pressure. So the two never get confused.

## 3. The model: 4 layers, one pass, streaming

```
telemetry row ─► [1] physics baseline ─► [2] CUSUM detectors ─► [3] forecasters ─► [4] cost optimizer ─► alert + plan
                 (expected value from      (adds up small         (countdown,         (exact search over
                  network.json)             evidence over time)    health trend)       trucks / wells / timing)
```

### Layer 1: physics baseline (no training)
- Expected pipeline pressure while pumping = disposal pressure + 50
- Expected discharge pressure = disposal pressure + 150
- Expected flow = `max_flow_bpd`, expected received = pumped
- Residual = expected − measured, divided by the sensor's noise σ

### Layer 2: CUSUM detectors (catch slow problems early)
CUSUM ("cumulative sum") adds each residual minus a slack `k`, never drops below 0, and alarms when the total passes `h`. A small, steady deviation that no single reading would reveal still adds up quickly.

- **Leak:** `S = max(0, S + pressure_deficit/σ − 2)`, alarm at `S > 10`
- **Worn pump:** `z = (flow_deficit/σ + discharge_deficit/σ)/2`, `S = max(0, S + z − 1)`, alarm at `S > 15`
- **Failure:** fault code 2, confidence 0.99
- **Onset time:** the first abnormal sample of the CUSUM run. For a worn pump, the trend line is extended back to where it left 100%.
- **Confidence** = `1 − e^(−S/h)`, so it rises smoothly instead of jumping from 0 to 1
- **Watch list:** any facility whose `S` reaches 30% of the alarm shows a yellow "WATCH" before the alarm fires
- **Thresholds were tuned on the history week.** H=6 (leak) and H=10 (wear) still had zero false positives, so we chose a 1.5× safety margin above those.

### Layer 3: forecasters (predict machine health ahead of time)
- **Tank countdown:** `hours = (shutdown − level) ÷ fill rate`, where fill rate = live well inflow ÷ 24 ÷ capacity. p10/p90 come from the slope ± 1.28 standard errors of the last hour of level readings.
- **Pump health:** a 6-hour linear trend of flow ÷ rated flow gives "94.1%, losing 0.4%/h, reaches 80% in ~35 h", so the inspector visit can be scheduled before the pump gets bad.
- **Leak:** live leak rate in bpd plus barrels lost so far.

### Layer 4: cost optimizer (exact, not heuristic)
For each failing pump, the search tries:
- 0 to fleet-size trucks, times every trip count that arrives before the repair
- every subset of the facility's wells to shut in (2³ = 8)
- the **latest** safe shut-in minute for that subset, by binary search (shutting in earlier is always safer)

Each candidate is checked exactly. Between events the tank only rises, so checking the level just before each truck arrival and at repair-end is enough. No time-stepping, no rounding error.

Several failures in one system: build each tank's best-cost-by-truck-count table, then try every split of the shared fleet. That's at most 4³ = 64 combinations. Total: about 1,000 plan checks per system, **< 1 ms**.

The cheapest plan is compared against **Do nothing** (lost oil + gas while the facility is shut in). The cheaper one wins.

## 4. Results (measured)

| Check | Result |
|---|---|
| Events found (full_week) | **23 / 23** |
| False positives (all 5 folders) | **0** |
| Pump failure detection delay | **0 min** (first faulted reading) |
| Leak detection delay | **15–20 min** (one case 70 min: pump was off, so the leak couldn't be seen) |
| Worn pump detection delay | **~3.5 h**, while the pump is still at ~98.5% health |
| Countdown vs answer key (snapshots) | within **0.02 h** (about 1 min) |
| Plan cost vs reference, 23 events + 7 snapshot plans | all within **3%**, and the same action chosen in every case |
| Shared-truck joint plans (3 failures, 2 trucks) | same split as the reference in both snapshots |

### How much earlier than "obvious"
- **Leak:** flagged at 15–20 min. The flow gap only passes 100 bpd after 4–8 h. That's **4–8 hours earlier**.
- **Worn pump:** flagged at ~98.5% health. It only drops below 95% after ~10–14 h. That's **~6–10 hours earlier**.

## 5. Cost efficiency

### Money saved (operations)
| full_week (S1–S5) | $ |
|---|---|
| Doing nothing on 13 pump failures | **$51,193** lost oil + gas |
| Our plans | **$15,297** |
| **Saved** | **$35,896 (70%)**, within 0.1% of the official reference plans |
| Rough yearly figure for this 5-system network (× 52) | **≈ $1.87 M / year** |

Snapshot "act now" savings: $4,069 (10-08 12:00), $13,570 (10-09 03:30), $19,892 (10-10 09:00).

### Money spent (compute)
- Parsing 393k readings: ~100 ms. Full week detection plus planning: ~7–10 ms (Node, M-series laptop).
- That's ~0.1 s of CPU per week of data. At $0.05/vCPU-hour it's **< 1¢ a year**. No GPU, no training run, no server: it runs in the browser tab.
- Model is 18 KB of plain JS with zero dependencies.

### Time saved (operator)
- A failure goes from fault reading to a costed plan in **< 1 ms**. Doing the same math by hand (8 shut-in combinations × truck options × timing × shared fleet) takes an operator tens of minutes, and that's minutes of tank level lost.

## 6. Live visualisation (`app/index.html`)
- **Replay** at 1 h to 1 day per second, or drag the slider to **time travel**: every view re-plans "as if now" (the full week rebuilds in a few ms).
- **KPI tiles:** saved vs doing nothing, model speed, compute cost, open problems, $ at risk right now.
- **Map:** one panel per system. Facility state uses shape + colour (● ◆ ▲ ■). Dashed truck routes from the yard show arrival times.
- **Alerts:** in the SPEC order. Failure cards show the countdown, a p10–p90 range in minutes, the plan, and an options table (do nothing / shut-in / trucks) with the cheapest highlighted. Leak and wear cards show confidence and evidence. WATCH cards are early warnings.
- **Charts:** 24 h tank level plus a 6 h forecast up to the shutdown line; pump health % and delivered % to show wear and leaks.
- **Glass box log + Export events.json** in the SPEC shape.

## 7. Run it
```
cd hack-utd
node app/check.js HackUTD-ZeroDay/history/full_week HackUTD-ZeroDay/history/snapshot_*   # score vs answer keys
python3 -m http.server 8000      # then open http://localhost:8000/app/
# or open app/index.html directly and use "Open folder…" to pick any dataset folder (e.g. test/)
```
On judging day, choose **test (judging)** in the dropdown (it reads `HackUTD-ZeroDay/test/`) or open that folder. No code changes.

## 8. Known limits / next steps
- ~~Noise σ values are fixed constants~~ **Fixed:** each facility now measures its own sensor noise from its first day of pumping (`noiseOf`), so thresholds adapt to the network loaded. See section 13.
- **A leak's end can only be confirmed when the pump runs again** (it's invisible while the pump is off). The end time can lag by up to the pump's off-cycle (~4–6 h).
- **Plans use live (noisy) inflow**, so the latest shut-in minute can be 1–2 min later than the reference. An optional safety buffer (e.g. +5% inflow) trades a few dollars for margin.
- Next, from the original idea: Field Crew phone view (vibration by severity), 30-second shift handoff, hash-chained audit log.

## 9. How the model "predicts" (in plain words)
It makes three kinds of forecast. None is a trained AI guess:
1. **When the tank will hit shutdown:** room left ÷ fill rate, from live readings (physics, accurate to ~1 min on the snapshots).
2. **That a slow problem is real, early:** the "evidence bar" (CUSUM) adds up small deviations from healthy. One odd reading is noise; a run of them crosses the alarm. Leaks are caught in 15–20 min, worn pumps at ~98.5% strength.
3. **Where a worn pump is heading:** a trend line on pump strength gives "reaches 80% in ~X h".

It does **not** predict a sudden pump failure from nothing. But in this data, 3 of the failing pumps showed wear **~32 h earlier**, and we catch that wear.

## 10. Cost assumptions (all from ops.json / SPEC.md)
| Item | How we price it |
|---|---|
| Truck trip | flat `cost_per_trip` ($905), any distance; removes `truck_capacity_bbl` (150) |
| Switching off a well | lost oil × $60/bbl + gas × $3/mcf, per hour it's off, until the repair |
| Doing nothing | every well at the facility loses revenue from the moment the tank trips until the repair |
| Repair | always `expected_repair_hours` (6 h) from onset |
| Fill rate | live well inflow averaged over the last hour, assumed constant |
| Not priced (no data) | inspector visits, leaked water, restart costs, truck ownership |

## 11. Where more savings come from (`maintenanceValue`, `fleetWhatIf`, `rebalance` in model.js)
1. **Daily plans: already optimal.** The search is exhaustive over trucks × trips × well subsets × exact minute, with the fleet shared. It matched the organizers' best plans. Going cheaper would mean breaking the rules or taking risk.
2. **Fix worn pumps during the warning.** S1_PUMP_C, S3_PUMP_A and S4_PUMP_C were flagged ~32 h before they failed. A repair in that window avoids **$3,620** of emergency trucks this week (and **$15,883** at risk if nobody acted). *Assumption: an early repair prevents the failure. The data can't prove this.*
3. **Move idle trucks.** We re-ran the week with every fleet size: S1 and S3 never need their extra trucks, while S2 and S4 run short. Moving **1 truck S1 → S2 saves $2,440/week** and **1 truck S3 → S4 saves $1,431/week** with the same 11 trucks. *Based on one week of data, so check it over more weeks before moving trucks for real.*

Together: **≈ $7,491/week** beyond the plan savings.

Optional safety knob (not built): plans use the live average inflow, so the latest shut-in minute can be 1–2 min tighter than a noise-free answer. Planning against inflow +5% costs a few dollars and buys margin.

## 12. Narrated story (ElevenLabs)
```
ELEVENLABS_API_KEY=your-key node app/serve.mjs     # then open http://localhost:8000/app/story.html and press 🔊 Voice
```
- `app/serve.mjs` serves the app and data and proxies `/tts` to ElevenLabs. The key stays in the terminal, never in the page.
- Each narration line is cached as an MP3 in `app/voice-cache/` (git-ignored). Do one full run-through before the demo; after that it plays instantly, offline, and spends no more credits.
- Optional: `ELEVENLABS_VOICE_ID` (any voice in your account) and `ELEVENLABS_MODEL_ID` (default `eleven_multilingual_v2`).
- No key or no network: it falls back to the browser's built-in voice.

## 13. Robustness and planner verification
**Self-calibrating noise (`noiseOf` in model.js).** Each facility measures its own pipeline-pressure, discharge-pressure and flow noise from its first 24 h. The method (median change between readings × 1.4826 ÷ √2) ignores the baseline and the odd jump, so a problem starting in that window barely affects it.

Noise stress test (extra random noise added to every pressure and flow sensor of full_week, noise re-measured):

| Sensor noise | Before | After self-calibration |
|---|---|---|
| 1× (real data) | 23/23, 0 false alarms | 23/23, 0 false alarms · leak 15 min · wear ~3.4 h |
| 1.5× | 23/23, 0 | 23/23, 0 |
| 2× | **2 missed, 2 false alarms** | 23/23, 0 · leak ~75 min · wear ~6 h |
| 3× | **45 false alarms** | 23/23, 0 · leak ~3 h · wear ~8 h |
| 4× | – | 23/23, 0 · leak ~5.5 h · wear ~13 h |

Noisier sensors now mean **slower** alerts, never false ones.

**Planner stress test (`node app/stress.js 1000`).** 1,000 random emergencies (tank 500–2,000 bbl, 1–4 wells, 0–3 trucks, varied drive and cycle times, the tank overflowing somewhere in the repair window) plus 200 random shared-fleet systems (2–4 failing tanks, 1–3 trucks). Each is solved by our planner and by an independent minute-by-minute brute force over every truck count, trip count, well subset and start minute.
- Result: **0 mismatches, worst cost gap $0.00**, and every chosen plan was re-simulated as safe. The answer mix was 213 truck-only, 292 shut-in-only, 239 both, and 256 where accepting the shutdown was cheapest.
- Our planner: ~15 µs per scenario.
- **The test can fail:** a planted bug (shut-ins over-charged by 3 minutes) was caught in 164 of 300 scenarios.

Why no "complex route" dataset: routes come from the coordinates in network.json and the drive times in ops.json, with no road network to plan over. The risks that matter are sensor noise (covered above) and planner edge cases (covered by the stress test).
