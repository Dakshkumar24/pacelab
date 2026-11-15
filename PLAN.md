# PaceLab: Execution Plan (rev. 2)

**PaceLab — Compare. Diagnose. Improve.**
Nov 14, 2026 · Daksh Kumar. Supersedes sections 2, 5 and 6 of the original brief. Sections 1, 3 and 4 stand, with the changes noted here.

**Main deliverable:** a working, Cloudflare-hosted app with two voice modes, live transcripts and a Turn Failure Report. Also required: 24 documented trials, a public GitHub repo and a one-page PM Decision Memo. No new features. No scope expansion.

---

## 1. Scope

### Tier 1: must ship (the MVP)

| Feature | What it does |
|---|---|
| Standard mode | `StandardVoiceAgent`, `eotThreshold: 0.70` |
| Patient mode | `PatientVoiceAgent`, `eotThreshold: 0.85` |
| Live microphone | Live call in either mode, with an interim transcript |
| Scenario picker + pause timer | Shows the script and paces each marked pause on screen |
| "Cut me off" button | Manual premature-turn label for live speech |
| Transcript repair | Inline `sendText()` box; the trial is marked repaired |
| Manual judgments | Per trial: transcription correct (y/n), response appropriate (y/n) |
| SDK timings | `turn_metrics` and `metrics` captured per turn (server clock) |
| TrialStore | Durable Object SQLite; every trial from both modes |
| CSV export | One file, all trials |
| Turn Failure Report | Per scenario, both modes side by side: outcomes, SDK timings, manual labels marked as manual |

Fixed across modes: LLM, voice, system prompt, script. The threshold is the only variable.

### Tier 2: stretch (starts only after the deployed MVP passes Phase 4)

- Deterministic 16 kHz mono WAV clip replay through the client's custom `audioInput`
- Automatic premature-turn labeling against each clip's speech-end mark
- Precise end-of-turn and first-audio delay, measured from the clip's speech-end mark
- Automated cost-per-successful-turn calculation
- Expansion to the 60-trial batch

### Out of scope

Telephony, multiple speakers, accounts, raw audio storage, any tuning beyond the one threshold.

### Cost

The unit-economics estimate (about $0.013 per conversation minute) stays in the product brief as an estimate. The Tier 1 memo cites it as an estimate. Automated cost per successful turn is Tier 2 only.

---

## 2. Architecture

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite, `useVoiceAgent` from `agents/voice/react` |
| Runtime | Cloudflare Workers, `routeAgentRequest` |
| Voice pipeline | `withVoice(Agent)` from `agents/voice` |
| Speech to text + end of turn | `WorkersAIFluxSTT` (`@cf/deepgram/flux`) |
| LLM | `@cf/google/gemma-4-26b-a4b-it` via `workers-ai-provider` |
| Text to speech | `WorkersAITTS` (`@cf/deepgram/aura-1`) |
| Storage | Durable Objects + SQLite only (no D1, no R2) |
| Delivery | GitHub + Cloudflare Git integration |

**Durable Object classes (3)**

- `PaceVoiceAgent` (abstract base): prompt, LLM, voice. Reads its threshold from `config.ts`.
- `StandardVoiceAgent` / `PatientVoiceAgent`: thin subclasses. Each one differs only in its threshold.
- `TrialStore`: one named instance holding every trial; serves list, CSV and report data.

**Session isolation.** Every trial connects to a fresh instance name (`trial-<uuid>`), so it starts with no conversation history.

**Turn commit signal.** The SDK already sends `{type:"transcript", role:"user"}` when Flux commits a turn. The client uses that message instead of a custom one, so no custom message is needed.

**Privacy.** Transcripts, labels and timings only. No raw audio. All content is fictional.

---

## 3. Metrics

### Tier 1: live trials

Every timing comes from the SDK's own server-clock metrics. Approximate client timings are never reported as precise latency.

| Metric | Source | Type |
|---|---|---|
| Premature interruption | Speaker's "cut me off" button, **or** the SDK committing more than one user turn for one scripted request | Manual + measured |
| Turns per request | Count of committed user transcripts | Measured |
| `speechStartToFinalMs` | `turn_metrics`: Flux speech start → finalized transcript | Measured (SDK) |
| `finalInputToFirstAudioMs` | `turn_metrics`: finalized input → first server audio | Measured (SDK) |
| `modelToFirstTextMs`, `llm_ms`, `tts_ms`, `first_audio_ms`, `total_ms` | `turn_metrics` / `metrics` | Measured (SDK) |
| Transcription correct | Transcript captures the key intent and details (e.g. day and time). Exact wording not required. | Manual |
| Response appropriate | The agent's reply fits the complete request, not a fragment of it | Manual |
| Repaired | A `sendText()` correction was needed | Logged |

**Added delay (Tier 1).** The difference in median `speechStartToFinalMs` between Patient and Standard on the same scenario. The script is the same, so speaking time roughly cancels out. Reported as **directional**, since speaker pacing varies between runs. Precise speech-end → commit delay is Tier 2.

**Successful turn (primary metric).** A turn counts only if all three hold:
1. No premature interruption
2. Correct understanding: transcription correct, with no repair needed
3. Appropriate response

**Reported per scenario and mode:** successful-turn rate, premature rate, transcription accuracy, response correctness, repair rate, and median / worst SDK timings.

### Success targets
- At least 25% fewer premature responses in Patient than in Standard
- Under 750 ms median added delay (directional, as defined above)
- At least 90% successful turns in the recommended mode

### Decision rule (fixed before any trial)
- **Patient becomes a documented preset** only if all three targets are met and premature turns drop by at least 2 trials.
- **Premature turns drop but delay misses its target:** document both presets with the trade-off, and set no default.
- **No clear drop:** recommend the evaluation workflow alone and name what to test next.

With 12 trials per mode, one trial moves a rate by about 8 points, so every result is directional.

---

## 4. Scenarios

| # | Scenario | Tests |
|---|---|---|
| 1 | Fluent speech, no pauses | Baseline |
| 2 | Short pause mid-phrase (2 s) | Most common hesitation |
| 3 | Long pause mid-phrase (**3 s**) | Hard case with a safe margin below Flux's 5 s `eotTimeoutMs` |
| 4 | Hesitations and repeated words | Fillers, restarts |
| 5 | Mid-sentence self-correction | "Tuesday, no, Wednesday" |
| 6 | Multiple pauses in one request | Repeated risk in one turn |

**Protocol:** 6 scenarios × 2 runs × 2 modes = 24 live trials. One speaker. The on-screen timer paces each pause, and modes alternate. Every trial uses a fresh instance. A trial that fails on a connection error is excluded and rerun, and the exclusion is logged. Nothing changes mid-batch, including the package version. If the same input gives different outcomes across runs, that variation is recorded as a finding.

---

## 5. Implementation order

Five phases in strict order. A phase starts only when the one before it meets every acceptance criterion. All Tier 2 work comes after Phase 5.

### Phase 1: Foundation and configuration (Sat Nov 14, 18:00–20:00)
1. Scaffold from `cloudflare/agents-starter` and pin `agents` to an exact version.
2. Set up the repo layout: `src/server.ts`, `src/config.ts`, `src/client.tsx`, `src/App.tsx`, `src/lib/`, `public/clips/`, `scripts/`, `docs/FRICTION.md`, `docs/FINDINGS.md`, `README.md`, `LICENSE`.
3. Configure `wrangler.jsonc`: AI binding, `nodejs_compat`, assets, observability, 3 DO bindings, one `v1` migration with all 3 classes in `new_sqlite_classes`.
4. Start on the Workers Free plan. Move to Workers Paid only with explicit approval, if the daily Workers AI allowance is reached.
5. Complete the source audit and record the answers in `FRICTION.md`.

**Accept:** the build and type check pass · `agents` is pinned · every audit question has a written answer.

### Phase 2: Dual-mode voice backend (Sat Nov 14, 20:00–23:30)
1. Shared base agent: prompt, LLM, voice.
2. `StandardVoiceAgent` (0.70) and `PatientVoiceAgent` (0.85) as thin subclasses.
3. `TrialStore` with its SQLite table.
4. Endpoints: create trial, list trials, export CSV, report data, delete all.

**Accept:** a live call works in both modes locally · the two classes differ by exactly one value · a new instance name starts with empty history · a trial written through the API appears in the CSV.

### Phase 3: Frontend Testbench and Turn Failure Report (Sun Nov 15, 09:00–13:00)
1. Mode switch, call controls, status, live and interim transcript.
2. Scenario picker with the script and an on-screen pause timer.
3. "Cut me off" button.
4. Inline `sendText()` repair.
5. Manual judgments (transcription correct, response appropriate), trial save, Turn Failure Report, CSV download.
6. Accessibility pass: keyboard operation, live regions, visible focus, no meaning carried by color alone.

**Accept:** a live trial in each mode saves with its manual labels and SDK timings · a repair marks the trial repaired · the report renders both modes per scenario · every control is reachable by keyboard.

### Phase 4: Deployment and verification (Sun Nov 15, 13:00–15:00)
Gates, in order, all on the deployed URL:
1. A push to GitHub triggers a successful Cloudflare build.
2. The URL loads over HTTPS and asks for microphone permission.
3. The WebSocket connects to both agent classes.
4. A live call completes in each mode with audible replies.
5. A labeled live trial saves from the deployed URL.
6. A trial persists across a reload and a redeploy.
7. CSV export has the correct columns and row count.
8. Observability shows no unhandled errors during a full call.

### Phase 5: Experiment and PM findings (Sun Nov 15, 15:00–20:30)
1. Finalize the six scripts with pauses marked.
2. Pilot one scenario in both modes, then run the 24 live trials.
3. Produce one results table per scenario and mode.
4. Write the friction log: tried / expected / happened / severity / fix.
5. Write the one-page Decision Memo: believed, built, measured, surprised, recommend, validate next.
6. Make the repo public and record the demo.

**Accept:** 24 valid trials in one CSV · a results table · at least 5 friction entries with fixes · every memo claim traces to a data row or a log entry · the live URL passes the Phase 4 gates again after the final deploy.

### Deadline
**Sun Nov 15, 20:30 PT:** final deploy, Phase 4 gates re-passed, repo public, memo done.
Buffer until 22:00. Tier 2 starts only after this.
