# Glass Box · Beat the Shutdown (HackUTD: ZeroDay)

An operator console for the oil-field salt-water network challenge. It finds pump failures, pipeline leaks and worn pumps from the sensor data, counts down to shutdown, and works out the cheapest fix (trucks, switching off wells, or doing nothing). Every alert shows its evidence and every plan shows its math.

## Run it (needs Node 18+)
```
node app/serve.mjs                 # if port 8000 is busy: PORT=8001 node app/serve.mjs
```
- Live console: http://localhost:8000/app/
- Story (11-step explainer): http://localhost:8000/app/story.html  ·  add `?auto=1&voice=1` for hands-free narration

Narration: the clips in `app/voice-cache/` play without any key. To generate new ones (e.g. for another dataset), put an ElevenLabs key in `app/.env` (copy `app/.env.example`). Without a key it falls back to the browser's voice.

## Check it
```
node app/check.js HackUTD-ZeroDay/history/full_week HackUTD-ZeroDay/history/snapshot_*   # vs. the answer keys
node app/stress.js 1000                                                                   # planner vs. brute force
```

## What's where
| Path | What |
|---|---|
| `app/model.js` | The model: streaming detectors, countdown, cheapest-plan optimizer, savings (no dependencies) |
| `app/index.html` | Live console: map, alerts, charts, time travel, savings, stress test |
| `app/story.html` | Full-screen explainer with the interactive "your turn" game |
| `app/serve.mjs` | Local server + ElevenLabs proxy (the key stays server-side) |
| `app/check.js`, `app/stress.js` | Accuracy checks and planner stress test |
| `app/PLAN.md` | Full write-up: how it works, measured results, cost assumptions |
| `HackUTD-ZeroDay/` | The challenge repo and data (github.com/nihaal419/HackUTD-ZeroDay) |
