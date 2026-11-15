# Methodology

## Question

Does raising Flux's end-of-turn threshold from 0.70 to 0.85 reduce premature agent replies on natural, paused speech, and what does it cost in waiting?

## Controlled variables

| Held constant | Value |
|---|---|
| Model | `@cf/google/gemma-4-26b-a4b-it`, `reasoningEffort: null` |
| Prompt | One fictional dental-scheduling prompt, one short spoken sentence per reply |
| Voice | `@cf/deepgram/aura-1`, `asteria` |
| STT | `@cf/deepgram/flux`, `eotTimeoutMs` 5000 |
| Scripts | The six scenarios below, word for word |
| Conversation state | A fresh agent instance per call |
| Infrastructure | Same Worker, same region selection, same day where possible |

The only intentional difference is `eotThreshold`: Standard 0.70, Patient 0.85.

## Scenarios

| # | Name | Script | Tests |
|---|---|---|---|
| 1 | Fluent baseline | "Can I book a cleaning for Tuesday afternoon?" | Recognition, turn completion, reply |
| 2 | Short pause | "I'd like to schedule a cleaning for..." *[2 s]* "...Thursday afternoon." | Short hesitation |
| 3 | Long pause | "Could you book my appointment for..." *[3 s]* "...Friday at ten in the morning?" | Longer mid-sentence silence |
| 4 | Hesitations | "Um, I was thinking, uh, Wednesday—no, Thursday afternoon." | Fillers and a restart |
| 5 | Self-correction | "Please book Monday at two PM—sorry, I meant Tuesday at four PM." | Following the corrected details |
| 6 | Multiple pauses | "I need an appointment..." *[2 s]* "...for next Thursday..." *[2 s]* "...around eleven AM." | Several chances to end early |

Scripts live in `src/lib/scenarios.ts`; the app and the tests read the same source.

## Design

- 6 scenarios × 2 modes × 2 repeats = **24 counted trials**.
- **Run order** (`PLAN_ORDER` in `src/lib/experiment.ts`): repeat 1 runs scenarios 1→6, repeat 2 runs 6→1, and the mode that goes first alternates by scenario and by repeat. Each scenario is run with each mode first exactly once, and three scenarios start with each mode in each repeat. This spreads practice and fatigue across both modes.
- The app recommends the next missing slot in that order. You may run slots out of order; the matrix still records which are done.
- Pauses are held by a person watching a silent visual timer. Nothing is played into the microphone. Held pauses are measured from the mic level and stored, so a run whose pauses were far off can be excluded.
- Use auto-end (on by default): the call ends shortly after the first reply, which keeps Workers AI usage low and makes every trial the same shape.

## Trial status

| Status | Meaning | In rates? |
|---|---|---|
| Counted | Fills a planned slot (at most 2 per scenario and mode). The server assigns run 1 or 2 | Yes |
| Exploratory | Kept for context, such as a third run or a practice call | No |
| Excluded | A conversational trial set aside, with a written reason (for example the speaker coughed) | No |
| Technical failure | The call failed to start, or nothing was recognized | No, reported separately |

A counted trial must contain at least one recognized request; the server rejects an empty one. Excluding a counted trial reopens its slot.

## Labels

Each is answered Yes, No or Unable to determine, after the call, by the person who ran it.

| Label | Yes means |
|---|---|
| Premature reply | The agent started replying before the scripted request was finished |
| Transcription correct | The recognized text kept the intent and the key details (day, time, correction). Exact wording is not required |
| Reply appropriate | The reply fits the whole request, not a fragment of it |
| Reply cut short | The agent's spoken reply was cancelled or cut off |

**A split is not a verdict.** When the SDK commits the request as two or more turns, PaceLab shows that as a measurement. It does not pre-fill "premature": a split can happen without the agent speaking early, and the agent can speak early on one turn. "Cut me off" presses are an observation made during the call, also not a label.

**Turn succeeded** = premature No, transcription Yes, reply Yes, and no typed correction. It is unknown when any of those three labels is unknown.

## Rates and denominators

- Every rate is `yes / judged`, where judged counts Yes and No. Unknowns are shown next to the rate and never enter it.
- Only counted trials enter rates and timings. Technical failures, exclusions and exploratory runs are counted separately.
- Timings are reported as median and range with `n`. *Speech start → final* is shown only for unsplit trials, because a split resets it.
- The decision summary says **Insufficient evidence** until each mode has at least 6 judged trials. It names a mode only when the gap is at least two trials and 15 percentage points, and labels any result as directional.

## What each timing can and cannot show

| Measure | Includes | Does not show |
|---|---|---|
| [SDK] Speech start → final transcript | Speaking time, every pause, the end-of-turn wait | Latency. One exploratory Patient run read 6,858 ms, mostly the speaker talking |
| [SDK] Final transcript → first audio | Model start-up, first sentence, first TTS audio | The end-of-turn wait before it; network and playback after it. Not affected by the threshold |
| [SDK] Model → first text | Gemma's time to first token (1.25–2.65 s observed) | Anything about turn-taking |
| [≈] Perceived wait | End-of-turn wait + server time + network + playback | A precise latency. Room noise or a soft last word move its start |

## Threats to validity

- **One speaker who knows the hypothesis** labels every trial. Labels could lean toward the expected result. Mitigation: label right after each call from the transcript evidence, and report unknowns.
- **Human pause timing.** Pauses vary run to run. Held pauses are recorded so they can be compared across modes.
- **Small sample.** Two repeats per cell. Results are directional; no significance test is meaningful at this size.
- **Order and practice effects.** Reduced, not removed, by the balanced order.
- **Model variance.** Gemma's start-up time varies by about a second and dominates server-side timing in both modes.
- **False speech detection.** Flux sometimes opens a turn on near-silence, and any speech start aborts the reply. Such runs should be excluded with a reason.
- **Same day, same network.** Results describe this setup, not every network or microphone.

## Next experiment

Replay the same recorded audio to both modes so the input is identical, and add a second speaker.
