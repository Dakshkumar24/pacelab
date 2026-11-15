# Decision memo: end-of-turn threshold for scheduling voice agents

**Status: no recommendation yet. Insufficient evidence.** The planned 24 trials have not been run. This memo states what will be decided, how, and what is known so far. It will be completed from the Turn Failure Report once the matrix is full.

## Problem

Voice agents built on the Agents SDK end a caller's turn when Flux is confident enough that the caller has finished. Callers booking appointments pause to think ("for... Thursday"). If the agent takes its turn during that pause, it answers half a request, talks over the caller, and the booking needs repair. Teams pick the threshold by feel.

## Hypothesis

Raising `eotThreshold` from 0.70 (Standard) to 0.85 (Patient) reduces premature replies on paused and disfluent requests, at the cost of a slightly longer wait after the caller stops.

## Experiment

Six scripted requests (fluent, 2 s pause, 3 s pause, fillers, self-correction, two pauses), two runs per mode, balanced order, one speaker. Everything except the threshold is held constant. A person labels each call; the SDK's timings and the browser's estimates are kept separate. Details: [METHODOLOGY.md](METHODOLOGY.md).

**Decision rule, set in advance:** name a better mode only if it has at least two fewer premature replies and a 15-point lower rate across at least 6 judged trials per mode. Otherwise report no clear difference.

## Findings so far (exploratory, not evidence)

- One multi-pause run per mode: Standard replied after "I need an appointment"; Patient waited for the full request and replied appropriately. This fits the hypothesis but is one run each ([FINDINGS.md](FINDINGS.md), E1).
- In that Patient run, 76% of the server-side time to first audio was the model starting up. That cost is the same in both modes and is not caused by the threshold.
- Startup failures seen on 2026-11-15 were the account's Workers AI daily allocation running out, not a turn-taking or code fault. Each trial costs real allocation, so 24 trials fit in about one to two UTC days.

## Trade-offs to weigh

| | Standard 0.70 | Patient 0.85 |
|---|---|---|
| Caller pauses mid-request | More likely to answer early (expected) | More likely to wait (expected) |
| Caller finishes cleanly | Answers slightly sooner | Waits a little longer before answering |
| Repair cost after a premature reply | Re-ask, cut-off speech, frustration | Lower if the hypothesis holds |
| Server-side reply time | Same model start-up, about 1.3–2.7 s | Same |

## Recommendation

None yet. Run the matrix.

## Next actions

1. Run the 24 counted trials with auto-end on, over one or two UTC days.
2. Fill this memo from the report: premature rate per mode, the scenarios where they differ, and the perceived-wait cost.
3. If the result is directional, repeat with recorded audio and a second speaker before changing a production default.
