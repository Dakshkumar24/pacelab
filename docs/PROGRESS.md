# Build progress

Working log for the v2 build, updated at every verified milestone. Newest status first.

## Where things stand (2026-11-15)

| Area | Status |
|---|---|
| P0 root cause of "Speech recognition failed to start" | Found and verified (below) |
| P0 fix: provider cause surfaced, call state machine, mic preflight, reservation with refunds, one call at a time, no fake trials | Done on `build/v2`; unit, API smoke and browser tests pass |
| P1 six scenarios, 24-trial plan, tri-state labels, technical failures, report with correct denominators, decision summary, safe delete, CSV injection protection | Done on `build/v2` |
| P2 workbench redesign, silent pause timer, synthetic demo mode | Done on `build/v2` |
| P3 45 unit tests, GitHub Actions CI, origin checks, security headers, safe previews block | Done; CI green on draft PR #1 |
| P4 README, ARCHITECTURE, METHODOLOGY, TESTING, DECISION_MEMO, DEMO, FINDINGS/FRICTION updates | Written; committed to `build/v2` |
| Merge to `main` (deploys production) | **Waiting for the owner's go-ahead** |
| Real-microphone checks and the 24 trials | Owner, in Chrome (docs/TESTING.md §4) |
| Screenshots in the README | Not done: binary files could not be committed through the browser-only workflow |

All work is on branch `build/v2` (draft PR #1). `main` is unchanged, so production still runs the previous version.

## Verified results

- GitHub Actions CI on PR #1: type check, unit tests, production build all succeeded.
- Cloudflare Workers Builds on `build/v2`: build and preview upload succeeded after adding the `previews` block.
- Clean-copy CI simulation (fresh `npm ci`): check, 45/45 tests, build.
- Local API smoke test against a dev server with no AI binding: 46/46.
- Local browser test with Chrome's fake microphone: 29/29.
- Every file on `build/v2` was hash-checked against the tested local copy.

## P0 root cause (verified 2026-11-15)

- Worker logs for the three failed calls (00:55:01, 00:55:22, 00:56:44 PST) each show `Flux STT WebSocket upgrade failed` then `Speech recognition failed to start`. In `agents@0.33.0` that pair means `env.AI.run("@cf/deepgram/flux", …, { websocket: true })` returned no WebSocket.
- The Workers AI usage page at the same time showed **10.25k of 10k neurons used** with "You have exceeded the Neuron limit of 10,000". Split: Flux 7.13k, Aura 3k, Gemma 123.
- So the free daily allocation was exhausted and Flux refused new sessions. It resets at 00:00 UTC.
- The counter rose from 19 to 21 because the old code reserved a slot before every WebSocket and never gave it back. The new accounting refunds failed starts.
- Not yet observed: the exact status and body Workers AI returns in this state. The new code logs it (`stage: stt_startup`) the next time it happens.

## Resume instructions

1. Read this file, then PR #1.
2. Do not merge to `main` without the owner's approval; a merge deploys production.
3. Never test with real voice calls or against production data; use `npm test` and the local scripts in docs/TESTING.md.
