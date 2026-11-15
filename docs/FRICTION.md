# Friction log

Format per entry: **tried / expected / happened / severity / suggested fix**.

## Phase 1 source audit (agents@0.33.0, pinned)

Answers come from the installed package's type definitions and compiled source (`node_modules/agents/dist/voice/`).

| # | Question | Answer | Where |
|---|---|---|---|
| A1 | Full option list of `WorkersAIFluxSTT` and its default threshold | `eotThreshold` (range 0.5–0.9, **default 0.7**), `eagerEotThreshold` (0.3–0.9, enables EagerEndOfTurn/TurnResumed), `eotTimeoutMs` (**default 5000**), `keyterms`, `sampleRate` (default 16000). Passed to Flux as `eot_threshold`, `eot_timeout_ms` strings. | `voice/workers-ai.d.ts`, `workers-ai.js:187-189` |
| A2 | Does the client's `audioInput` accept a custom audio source? | **Yes.** `VoiceClientOptions.audioInput: VoiceAudioInput` with `start()`, `stop()`, `onAudioLevel(rms)`, and optional `onAudioData(pcm)` for 16 kHz mono 16-bit LE PCM forwarded over the same WebSocket. Relevant to Tier 2 only. | `voice/client.d.ts:47`, `types-*.d.ts` `VoiceAudioInput` |
| A3 | Where do the built-in pipeline metrics start their clock? | `metrics` (`llm_ms`, `tts_ms`, `first_audio_ms`, `total_ms`) start at **turn-pipeline start, after STT finalizes** (before `afterTranscribe`). They exclude STT and browser playback. `turn_metrics` adds `speechStartToFinalMs` (Flux speech start → finalized transcript), `finalInputToFirstAudioMs`, `modelToFirstTextMs`, and others, all on one server clock. | `VoicePipelineMetrics`, `VoiceTurnMetrics` |
| A4 | How does the server send a custom message to one connection? | `connection.send(JSON.stringify(...))`. The client surfaces non-protocol messages as `lastCustomMessage` on `useVoiceAgent`. **Not needed:** the SDK already emits `{type:"transcript", role:"user"}` on turn commit. | `UseVoiceAgentReturn.lastCustomMessage` |
| A5 | Is `@cf/google/gemma-4-26b-a4b-it` in the catalog and off the retirement list? | **Yes to both.** It is in the generated `AiModels` types, and Cloudflare's Nov 5, 2026 deprecation notice names it as a recommended replacement. Neither `@cf/deepgram/flux` nor `@cf/deepgram/aura-1` is on the Nov 20 retirement list. Kimi K2.6 is. Cloudflare's July 28, 2026 changelog lists it as still available on Workers Free. Model ID lives only in `src/config.ts`. | starter `env.d.ts`; Cloudflare changelogs 2026-07-28 and 2026-11-05 |

## Entries

### F1. Client silence detection looks like it ends turns, but it doesn't
- **Tried:** Checked whether `VoiceClient`'s default 500 ms silence detector could override `eotThreshold`.
- **Expected:** If `end_of_speech` forced a turn end, the threshold would never matter for pauses over 500 ms, and the experiment would be invalid.
- **Happened:** The server ignores `start_of_speech` / `end_of_speech` (`case "end_of_speech": break;`). Flux decides end of turn on its own. Not documented on the client option.
- **Severity:** Medium. A developer reading `silenceDurationMs` will reasonably think it controls turn-taking.
- **Fix:** Document on `silenceDurationMs` that with Flux it drives UI and interrupt detection only, not end of turn.

### F2. Threshold range and timeout are only in type comments
- **Tried:** Looked for guidance on choosing `eotThreshold`.
- **Expected:** Presets or a documented trade-off.
- **Happened:** The only guidance is a JSDoc comment: range 0.5–0.9, default 0.7. `eotTimeoutMs` (default 5000) is configurable but easy to miss, and it silently caps any pause test.
- **Severity:** High. This is the core gap PaceLab addresses.
- **Fix:** Named presets with measured trade-offs (see the Decision Memo).

### F3. Starter template lags the SDK
- **Tried:** Scaffolded from `cloudflare/agents-starter`.
- **Expected:** A current `agents` version with a voice example.
- **Happened:** The starter pins `agents ^0.17.4` (latest is 0.33.0), `ai` v6 (`workers-ai-provider` 4.x needs `ai` v7), and is chat-only, with no voice wiring.
- **Severity:** Low.
- **Fix:** Add a voice variant to the starter, or a `--template voice` option.

### F4. `workers-ai-provider` is deprecated, and the starter still depends on it
- **Tried:** Kept the starter's `workers-ai-provider` dependency for the LLM call.
- **Expected:** The starter to use the current recommended provider.
- **Happened:** The package README says it is deprecated in favor of `createAI` from `agents/models/ai-sdk`. The starter template and its `ai` v6 pin predate that.
- **Severity:** Low. It still works.
- **Fix:** Phase 2 uses `createAI({ binding: env.AI })` and does not import `workers-ai-provider`. The package stays in `package.json` only so the committed lock file stays in sync. The starter should switch to `createAI`.

### F5. Local dev cannot start without a Cloudflare login
- **Tried:** `npm run dev` on a fresh checkout with no Cloudflare credentials.
- **Expected:** The page and Durable Objects to run locally, with only AI calls failing.
- **Happened:** The dev server exits at startup: the `AI` binding is always remote, and the remote proxy session needs `wrangler login` or `CLOUDFLARE_API_TOKEN`. With the binding removed, the page, `/api/health` and all three agent WebSocket routes work.
- **Severity:** Medium. A day-two developer cannot see anything before authenticating, and CI or sandboxed environments cannot run the app at all.
- **Fix:** Start the dev server without the remote session and fail only on the first `env.AI` call, with a message naming `wrangler login`.

### F6. Gemma 4 reasons silently by default, which looks like a broken voice pipeline
- **Tried:** `streamText` through `createAI({ binding })` with `@cf/google/gemma-4-26b-a4b-it`, the same way as any chat model.
- **Expected:** First text in about a second, as a voice turn needs.
- **Happened:** First visible text came 5–21 s after the transcript. The model spends that time on hidden reasoning before it writes anything. During the wait, any Flux speech start (see F7) aborted the turn, so the user saw their own transcripts and never got a reply. Nothing in the logs pointed at the model.
- **Severity:** High. It cost a debugging session, and a developer would blame STT or TTS first.
- **Fix:** Pass `reasoningEffort: null` in the model options. After that, first text took 1.25–2.65 s in our runs. Voice docs and examples that use a reasoning model should set it, or the voice helper should default it.

### F7. Any Flux speech start aborts the agent's turn, with no option to change it
- **Tried:** Looked for a way to ignore short noises while the agent is thinking or speaking.
- **Expected:** A barge-in setting, such as a minimum speech length or off.
- **Happened:** Every Flux `StartOfTurn` goes to `_handleBargeIn`, which aborts the active turn. This includes false starts on near-silence (F8) and the user saying "hello?" while waiting for a slow model (F6). There is no config option.
- **Severity:** Medium–High. A false barge-in looks like a turn-taking failure, and it confounds any threshold comparison.
- **Fix:** A barge-in option: off, a minimum speech duration, or only after an interim transcript arrives.

### F8. Flux sometimes opens a turn on near-silence
- **Tried:** Probes that streamed low-level noise between utterances, and the user's first live calls.
- **Expected:** No speech events without speech.
- **Happened:** Flux occasionally reported speech start with no one talking, and short fragments appeared in the user's first live test. Observed, not counted. With F7, each false start can cut off a reply.
- **Severity:** Medium.
- **Fix:** Document expected behavior on noise. Pairs with the F7 option.

### F9. Flux closes its socket after about 5 s without audio
- **Tried:** A probe that sent nothing between utterances.
- **Expected:** The STT session to stay open for the whole call.
- **Happened:** The Flux connection dropped after about 5 s of no audio, and the call ended. The browser client streams the mic continuously, so normal calls are mostly unaffected. A muted mic or a stalled audio stream would end the call the same way. We have not confirmed this case in a real browser.
- **Severity:** Medium.
- **Fix:** Send keep-alive silence in the server's STT session, or document the limit.

### F10. `speechStartToFinalMs` reads like latency but isn't
- **Tried:** Used `turn_metrics` to compare how long each mode makes the user wait.
- **Expected:** A metric for the end-of-turn wait after the user stops speaking.
- **Happened:** `speechStartToFinalMs` runs from speech start to the final transcript, so it includes speaking time and every pause. One Patient trial read 6858 ms, mostly the user talking. No SDK metric isolates the wait after the last word.
- **Severity:** Medium. It is the number a PM would quote, and it is the wrong one.
- **Fix:** Add a `speechEndToFinalMs` (last speech end → final) to `turn_metrics`, and document what `speechStartToFinalMs` covers.

### F11. "Speech recognition failed to start" hides the provider's reason
- **Tried:** Starting calls after a day of testing on Workers Free.
- **Expected:** An error that says why Flux would not start.
- **Happened:** The SDK logged `Flux STT WebSocket upgrade failed` and sent the browser only "Speech recognition failed to start". The cause, the account's 10,000-neuron daily allocation being used up, was visible only on the Workers AI usage page. Each retry also used one of PaceLab's call slots, because the old code counted a slot before the call came up.
- **Severity:** High. It looks like an app bug, and nothing in the error points at billing or quota.
- **Fix:** PaceLab now wraps the AI binding, reads the response Workers AI returns instead of a WebSocket, logs a sanitized cause, and tells the browser. Failed starts give their slot back. The SDK should include the provider's status and message in its error, and Workers AI could return a distinct quota error.

### F12. Flux bills for open time, so the free allocation runs out sooner than expected
- **Tried:** Planning the 24 trials on Workers Free.
- **Expected:** A few dozen short calls to fit easily in 10,000 neurons.
- **Happened:** Flux is billed per audio minute while the session is open (700 neurons a minute at list price) and Aura per character spoken. On the day the allocation ran out, Flux accounted for 7.13k of 10.25k neurons. A call left open while someone reads or labels costs as much as one in use.
- **Severity:** Medium for anyone building voice on the free plan.
- **Fix:** PaceLab ends a call shortly after the first reply and shows an estimated budget. Voice docs could give a per-minute cost for the pipeline, and the SDK could close Flux after an idle period.

### Environment note (not SDK friction)
The built-in browser pane in the Claude desktop app does not grant microphone access, so live calls run in a normal browser.

## Phase 1 compatibility check (agents@0.33.0)

Verified by compiling a probe file against the installed packages and by `wrangler deploy --dry-run`.

| Check | Result |
|---|---|
| Voice imports: `withVoice`, `WorkersAIFluxSTT`, `WorkersAITTS` from `agents/voice`; `useVoiceAgent` from `agents/voice/react` | Type-check and runtime import pass |
| Flux end-of-turn threshold | `eotThreshold` and `eotTimeoutMs` accepted; sent to `@cf/deepgram/flux` as `eot_threshold` / `eot_timeout_ms` |
| Gemma 4 availability | `@cf/google/gemma-4-26b-a4b-it` in `AiModels`; not being retired; available on Workers Free |
| TTS | `WorkersAITTS` defaults to `@cf/deepgram/aura-1`, speaker `asteria`; not being retired |
| SDK metrics | `metrics` (`llm_ms`, `tts_ms`, `first_audio_ms`, `total_ms`) and `turn_metrics` (`speechStartToFinalMs`, `finalInputToFirstAudioMs`, `modelToFirstTextMs`, ...) exposed on `useVoiceAgent` |
| Durable Object config | Dry run resolves `StandardVoiceAgent`, `PatientVoiceAgent`, `TrialStore` and the `AI` binding; one `v1` migration with all three in `new_sqlite_classes` |
| Live voice call | Working in both modes since 2026-11-15, after the F6 fix (probe and live microphone) |
