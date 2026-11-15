# Findings

_The Phase 5 results table (24 trials, per scenario and mode) and the one-page PM Decision Memo go here._

## How to read the measurements

Every number in the app, the CSV and this file carries one of three tags.

| Tag | Source | Use it for |
|---|---|---|
| [SDK] | Agents SDK `turn_metrics`, server clock | Pipeline stages after the turn is committed |
| [M] | Manual label from the person running the trial | Premature turn, transcription correct, response appropriate |
| [≈] | Browser clock in the testbench page | Approximate wait the user perceives |

**Perceived wait [≈]** is measured from the last moment the browser mic level was above 0.04 while the agent was listening, to the moment the client switched to `speaking`. It includes things no SDK number covers: the end-of-turn wait after the last word, the network, and browser playback. It is approximate:
- background noise keeps the level up, so the wait reads short
- a quiet last word falls below the level, so the wait reads long
- page rendering adds tens of milliseconds

Use it to compare modes, not as a precise latency figure.

## Exploratory observations (not part of the 24-trial batch)

These are single runs, made before trial persistence existed and before the scenario scripts were final. **They are not statistical evidence**, and they are not in the Turn Failure Report. They are kept as context for designing the batch.

### E1. Multi-pause request, live microphone, 2026-11-15

Script (scenario 6): "I need an appointment [2 s] for next Thursday [2 s] around eleven AM."

| | Standard (0.70) | Patient (0.85) |
|---|---|---|
| What happened [M] | Agent replied after "I need an appointment", before the request was finished | Waited for the whole request. One transcript: "I need an appointment for next Thursday around eleven AM." Reply was appropriate |
| Premature turn [M] | Yes (observed) | No |
| Speech start → final transcript [SDK] | not recorded | 6858 ms |
| Final input → first audio [SDK] | not recorded | 3476 ms |
| Model → first text [SDK] | not recorded | 2650 ms |
| Outcome [SDK] | not recorded | completed |

This fits the hypothesis that a higher threshold tolerates mid-request pauses, but it does not establish it. There was one run per mode, the speaker knew the hypothesis, and the pauses were timed by feel.

**Why 6858 ms is not latency.** Speech start → final runs from Flux detecting speech to the finalized transcript. It includes the time spent speaking, both 2 s pauses and the end-of-turn wait after the last word. Only that last part is the cost of Patient mode, and in a multi-pause request this metric cannot separate it. That is why the report shows this measure for single-turn trials only and labels the Patient − Standard difference as directional.

**Where the 3476 ms went.** Final input → first audio runs from the finalized transcript to the first speech audio leaving the server.
- Model → first text: 2650 ms (76%). This is Gemma 4's time to its first visible token.
- The other ~826 ms covers the `afterTranscribe` step, waiting until the first sentence is complete, and Aura's first audio chunk. Probes measured about 30 ms for `afterTranscribe` and about 500 ms for TTS → first audio; the rest is first-sentence buffering. That split is inferred from the probes, not measured in this run.
- Gemma's first text ranged from 1252 ms to 2650 ms across runs after the F6 fix, so the model dominates and varies.

The threshold changes *when* the turn ends, not how fast the reply is generated. Both modes use the same model and prompt, so the 3476 ms is not a cost of Patient mode.

**What the user felt** is neither SDK number on its own. It is roughly the end-of-turn wait after the last word, plus final input → first audio, plus network and playback. The testbench now records it as perceived wait [≈].

### E2. Diagnostic probes (synthesized audio, not a human speaker)

- Before the F6 fix, Gemma's first text took 5–21 s, and turns were aborted by barge-in before any reply.
- After the fix, a Patient probe completed: model → first text 1252 ms, final input → first audio 2149 ms.
- With clean audio, Flux ended the turn 139–241 ms after speech stopped.

These probes show the pipeline works. They say nothing about pauses.
