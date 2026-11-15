# Build progress

Working log for the final build. Updated at every verified milestone so an interrupted session can resume. Newest status first.

## Where things stand

| Area | Status |
|---|---|
| P0 root cause of "Speech recognition failed to start" | **Found and verified** (see below) |
| P0 fix: precise errors, call state machine, quota accounting, no fake trials | In progress on branch `build/v2` |
| P1 evaluation workflow and report | In progress on branch `build/v2` |
| P2 frontend, pause guide, demo mode | Not started |
| P3 tests, security, CI | Not started |
| P4 README and docs | Not started |

Work happens on the branch `build/v2`. `main` only changes when a milestone is verified, because every commit to `main` deploys to production.

## P0 root cause (verified 2026-11-15)

- Worker logs for the three failed calls (00:55:01, 00:55:22, 00:56:44 PST) each show `Flux STT WebSocket upgrade failed` then `Speech recognition failed to start`. In the SDK that pair means `env.AI.run("@cf/deepgram/flux", ..., { websocket: true })` returned a response with no WebSocket.
- The Workers AI usage page at the same time showed **10.25k of 10k neurons used**, with the banner "You have exceeded the Neuron limit of 10,000". Split: Flux 7.13k, Aura 3k, Gemma 123.
- So the account's free daily Workers AI allocation was used up, and Flux refused new sessions. It resets at 00:00 UTC (4 pm Pacific).
- Not yet captured: the exact status and body Workers AI returns in this case. The SDK discards it. The fix logs it.

What this means for the experiment:
- Flux bills 700 neurons per audio minute for as long as the call is open. Aura-1 bills about 1,364 neurons per 1,000 characters spoken. A 30-second call with a two-sentence reply costs roughly 500 neurons, so the free allocation covers about 20 such calls a day, fewer than the app's 30-call cap.
- The 24-trial batch only fits in one UTC day if calls are short. The fix ends each call automatically after the first reply and shows an estimated neuron budget.

## Resume instructions

1. Read this file, then the commit history on `main` and `build/v2`.
2. Continue with the first row above that is not done.
3. Never test with real voice calls; use the unit tests and the local dev server without the AI binding.
