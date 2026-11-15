# Two-minute demo

For a Cloudflare PM or engineer. Use the live site. Open `/?demo` in a second tab beforehand in case the microphone or the Workers AI allocation is unavailable.

## 0:00 The problem (20 s)

"Voice agents demo well, then cut real callers off. People pause mid-sentence, and an end-of-turn model has to guess whether they're done. On the Agents SDK that guess is Flux's `eotThreshold`. PaceLab measures that trade-off instead of guessing."

## 0:20 The setup (20 s)

Point at the Configure card: Standard 0.70 vs Patient 0.85, everything else identical. Point at the script for scenario 6 with its two pause markers. "Six scripts like this, two modes, two runs each: 24 trials. The matrix tells me what to run next."

## 0:40 Show the failure (35 s)

Live: run scenario 6 in Standard. Read the script and hold the first pause. The agent replies after "I need an appointment". Press **Cut me off**.

Fallback: in the demo, press **Play the example** and point at "reply cut off" on the Standard side and the full request on the Patient side.

## 1:15 Evidence, then judgment (20 s)

On the label form: "These are separate. The SDK says the request was committed as two turns; that's a fact. Whether the agent replied too early is my judgment, Yes / No / Unable to determine. Startup failures never count as trials." Save as Counted.

## 1:35 The report (20 s)

Scroll to the Turn Failure Report. "Rates are yes over judged, with unknowns listed. The model's start-up time is the same in both modes; *speech start → final* includes my own talking, so it isn't latency. Until each mode has six judged trials, the decision says *Insufficient evidence*."

## 1:55 What PaceLab adds (5 s)

"A repeatable way to choose a turn-taking setting on evidence, with the SDK friction we hit written up in FRICTION.md."

## If something goes wrong

- *"Workers AI's free daily allocation is used up"*: say so; it is the account's 10k-neuron daily limit, shown by the app with its reset time. Switch to the demo.
- Microphone blocked: the failure card explains it and no call slot was used. Switch to the demo.
