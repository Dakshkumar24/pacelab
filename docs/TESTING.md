# Testing

Automated tests never use production, never make real voice calls and never touch real trials.

## 1. Unit tests (CI)

```sh
npm test      # node --test test/*.test.ts, Node 22+
npm run check # tsc --noEmit
npm run build
```

45 tests in `test/`:

| File | Covers |
|---|---|
| `trial.test.ts` | Scenario scripts and pauses; trial validation (empty sessions, technical failures, exclusion reasons, missing labels, bad ids, demo ids refused); split is not premature; turn success; CSV quoting and formula-injection protection; reading old rows as exploratory |
| `experiment.test.ts` | 24-slot balanced plan; progress and next slot; only counted trials count; third run refused; report denominators with unknowns, exclusions and technical failures; missing timings; decision thresholds |
| `call.test.ts` | Call state machine including double Start/End, cancel during startup, late events, timeouts; provider and microphone failure classification; provider text sanitizing; reservation, refunds, caps, one-call-at-a-time, stale-row settling, neuron estimate; session tokens and passphrase check |

GitHub Actions runs type check, unit tests and build on every pull request and every push to `main` (`.github/workflows/ci.yml`). CI needs no secrets.

## 2. Local API smoke test

`scripts/smoke-local.mjs` runs 46 checks against a local dev server: sign-in, lockout responses, cross-site refusal, internal routes hidden, WebSocket refused without a reservation or cookie, a failed start that gives its slot back, one call at a time, trial validation, server-assigned run numbers, the cell limit, exclusion, CSV, the delete confirmation and archive, and sign-out.

Run it with the AI binding removed so no Workers AI usage is possible:

```sh
cp wrangler.jsonc /tmp/wrangler.jsonc.bak
sed -i '/"ai": {/d' wrangler.jsonc          # local only, do not commit
printf 'PACELAB_PASSPHRASE=local-test-only\nPACELAB_TOKEN_SECRET=local-signing-key-for-tests-only\n' > .dev.vars
npx vite dev --port 5199 &
node scripts/smoke-local.mjs
cp /tmp/wrangler.jsonc.bak wrangler.jsonc; rm .dev.vars
```

Without the binding, starting a call fails in the agent, which is how the test exercises the startup-failure path. The script refuses to run against any host other than localhost.

## 3. Local browser test

`scripts/ui-local.mjs` drives the real UI in headless Chrome with a fake microphone (29 checks): the gate, the demo (labelled synthetic, makes no API or agent requests), the recommended trial, pause markers, a double-clicked Start making one reservation, the failure card instead of a label form, the slot not being used, recording a technical failure, persistence across reload, Start then Cancel never getting stuck, the delete confirmation, no horizontal overflow at 390 px, no page errors, and a denied microphone failing before any reservation.

```sh
npm i -g playwright && npx playwright install chrome
PLAYWRIGHT_DIR=$(npm root -g) node scripts/ui-local.mjs   # same local server as above
```

Screenshots are written to `test-results/ui/` (ignored by git).

## 4. Manual checks in Chrome (need a real microphone)

Do these on the deployed site, in Chrome, not in an embedded browser. Each live call uses Workers AI allocation, so this list uses at most four calls.

| # | Do | Expect |
|---|---|---|
| 1 | Block the microphone for the site, press Start | "The browser blocked the microphone", calls-left unchanged |
| 2 | Allow it, run the recommended trial, read the script | "Listening", committed turns appear, agent replies, call ends by itself, label form opens |
| 3 | Label and save as Counted, then reload | Confirmation banner; the trial, matrix dot and report row survive reload |
| 4 | Press Start then Cancel within a second | Back to Ready, no stuck state, calls-left unchanged after a few seconds |
| 5 | Download the CSV | One row per trial, columns tagged `sdk_`, `manual_`, `approx_` |
| 6 | Open the demo | Synthetic banner; nothing is saved |

## Startup troubleshooting

| Message | Likely cause | Fix |
|---|---|---|
| Workers AI's free daily allocation is used up | Account over 10,000 neurons today (check Workers AI → Usage) | Wait for 00:00 UTC. Nothing to fix in code |
| The browser blocked the microphone | Site permission denied | Allow the microphone in the address bar |
| No microphone was found / in use | Device missing or held by another app | Connect or free the device |
| Today's call cap is used up | 30 established calls today | Wait for 00:00 UTC |
| Another call is still open | Previous call still closing | Wait a few seconds |
| The call did not start within 15 seconds | Network or provider slowness | Retry; check Worker logs |
| Speech recognition did not start | Provider refused without detail | Check Worker logs for `stage: stt_startup` |

Worker logs: Cloudflare dashboard → Workers → pacelab → Observability. Look for entries with `component: "PaceLab"`.

## Regression checklist before merging to `main`

- [ ] CI green (type check, unit tests, build)
- [ ] Local smoke test 46/46 and browser test 29/29
- [ ] `wrangler.jsonc` still has the `ai` binding (the local test edit was reverted)
- [ ] No `.dev.vars` or secret in the diff
- [ ] Manual checks 1–3 after deploying
