# Glass Box · Beat the Shutdown (HackUTD: ZeroDay)

An operator console for the oil-field salt-water network challenge. It finds pump failures, pipeline leaks and worn pumps from the sensor data, counts down to shutdown, and works out the cheapest fix (trucks, switching off wells, or doing nothing). Every alert shows its evidence and every plan shows its math.

## Run it (needs Node 18+)
The data lives in `HackUTD-ZeroDay/` next to `app/` (clone github.com/nihaal419/HackUTD-ZeroDay there, or symlink an existing copy: `ln -s ../HackUTD-ZeroDay HackUTD-ZeroDay`).
```
NTFY_DRY_RUN=1 node app/serve.mjs  # pushes are logged, not sent. If port 8000 is busy: PORT=8001 node app/serve.mjs
```
- Live console: http://localhost:8000/app/  (the server owns the replay clock; the page follows it)
- Story (11-step explainer): http://localhost:8000/app/story.html  ·  add `?auto=1&voice=1` for hands-free narration
- `DATASET=history/snapshot_2026-10-10T0900 node app/serve.mjs` starts on another folder; the dropdown switches too.

## Field alerts (phone + watch)
The alert layer sits after the model: one alert per problem, a push to the control room's phone through [ntfy](https://ntfy.sh) (the Garmin mirrors it), a claim page, escalation, and a dashboard panel that shows who is on what.
1. Install the ntfy app on the phone. Start the server once; it prints `subscribe your phone to control-room-<random>` and saves the topic in `app/.env`. Subscribe to that topic.
2. The phone must reach this machine to open claim links. Run a tunnel (`cloudflared tunnel --url http://localhost:8000` or ngrok) and start the server with `PUBLIC_URL=https://<your-tunnel-host>`.
3. Press ▶ Replay. When the model finds a problem the replay **holds** until someone decides (switch it off in the field panel). The phone buzzes with the plan, the approve-by time and what missing it costs. Tap → approve on the claim page → the dashboard routes trucks and shut-ins.
4. Everyone else (backup supervisor, drivers, inspection crew) is simulated: their Claim / Can't / lost-signal buttons are on the dashboard.

How it decides (all in `app/alerts.js`, no network inside):
- **Approve by** = the last start time at which the cheapest plan still works, found by re-running the optimizer at later start times (`approveBy` in `model.js`). Severity comes from that deadline, not from time to shutdown: trucks need 65–100 min to arrive, so "critical under 1 h to shutdown" would fire after the truck plan is already gone. Missing the deadline falls back to the next-cheapest plan (usually a well shut-in), not straight to shutdown.
- **Timers run on replay time** and scale with the deadline (escalation after ¼ of the time left, 2–10 min). A truck job nobody claims re-plans automatically with the trucks actually available.
- **Bundles:** failures in one system are approved together, so the shared-fleet split from the optimizer survives. "First N claims win" for N trucks; shut-ins become owned tasks that buzz at the exact minute.
- **Worn pumps** go to an inspection queue with a 24 h deadline (3 of them failed ~32 h after the warning in this data). **Leaks** show "awaiting confirmation" while the pump is off, because a leak's end can only be seen when it runs.
- **Audit log** (who approved what, when, every push and override): `Export audit.json` on the dashboard. Topics and claim links are random tokens.

Narration: the clips in `app/voice-cache/` play without any key. To generate new ones (e.g. for another dataset), put an ElevenLabs key in `app/.env` (copy `app/.env.example`). Without a key it falls back to the browser's voice.

## Check it
```
node app/check.js HackUTD-ZeroDay/history/full_week HackUTD-ZeroDay/history/snapshot_*   # vs. the answer keys
node app/stress.js 1000                                                                   # planner vs. brute force
node app/alerts.test.js                                                                   # alert engine over full_week, 6 scripted scenarios
```

## What's where
| Path | What |
|---|---|
| `app/model.js` | The model: streaming detectors, countdown, cheapest-plan optimizer, savings (no dependencies) |
| `app/index.html` | Live console: map, alerts, charts, time travel, savings, stress test |
| `app/story.html` | Full-screen explainer with the interactive "your turn" game |
| `app/alerts.js` | Field alert engine: approve-by severity, escalation, bundles, truck jobs, shut-in tasks, inspection queue, audit |
| `app/serve.mjs` | Local server: replay clock, alert API, claim links, ntfy pushes, ElevenLabs proxy |
| `app/notify.mjs`, `app/claim.html`, `app/roles.json` | ntfy adapter, the phone's claim page, who gets buzzed |
| `app/check.js`, `app/stress.js`, `app/alerts.test.js` | Accuracy checks, planner stress test, alert engine scenarios |
| `app/PLAN.md` | Full write-up: how it works, measured results, cost assumptions |
| `HackUTD-ZeroDay/` | The challenge repo and data (github.com/nihaal419/HackUTD-ZeroDay) |
