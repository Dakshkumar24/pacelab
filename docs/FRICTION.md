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
- **Fix:** Phase 2 uses `createAI({ binding: env.AI })` and drops `workers-ai-provider`. The starter should do the same.

### F5. Local dev cannot start without a Cloudflare login
- **Tried:** `npm run dev` on a fresh checkout with no Cloudflare credentials.
- **Expected:** The page and Durable Objects to run locally, with only AI calls failing.
- **Happened:** The dev server exits at startup: the `AI` binding is always remote, and the remote proxy session needs `wrangler login` or `CLOUDFLARE_API_TOKEN`. With the binding removed, the page, `/api/health` and all three agent WebSocket routes work.
- **Severity:** Medium. A day-two developer cannot see anything before authenticating, and CI or sandboxed environments cannot run the app at all.
- **Fix:** Start the dev server without the remote session and fail only on the first `env.AI` call, with a message naming `wrangler login`.

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
| Live voice call | **Not tested.** Needs a Cloudflare login |
