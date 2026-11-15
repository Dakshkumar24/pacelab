/**
 * SYNTHETIC demo data. Nothing here was measured. It exists so the workflow
 * and the report can be shown without a microphone, a passphrase or any
 * Workers AI usage. Demo trials have ids starting "demo-", which the server
 * refuses to store, and they are only ever held in the browser.
 */
import { EOT_THRESHOLD } from "../config.ts";
import { PLAN_ORDER } from "./experiment.ts";
import { SCENARIOS, scriptedPauses } from "./scenarios.ts";
import type { Mode, Trial, TrialEvent } from "./trial.ts";

/** Invented outcome pattern: Standard answers early on the paused scenarios. */
function inventedPremature(scenario: number, mode: Mode, repeat: number): boolean {
  if (mode === "patient") return scenario === 3 && repeat === 2;
  return scenario === 3 || scenario === 6 || (scenario === 2 && repeat === 1);
}

function demoTrial(scenario: number, mode: Mode, repeat: number, index: number): Trial {
  const script = SCENARIOS[scenario - 1];
  const said = script.parts.flatMap((p) => ("say" in p ? [p.say.replace(/\.\.\./g, "").trim()] : []));
  const premature = inventedPremature(scenario, mode, repeat);
  const transcripts = premature ? [said[0], said.slice(1).join(" ")] : [said.join(" ")];
  const wait = (mode === "patient" ? 2900 : 2300) + ((index * 137) % 400);
  return {
    schema: 2,
    id: `demo-${mode}-${scenario}-${repeat}`,
    createdAt: Date.UTC(2026, 0, 1, 12, index),
    mode,
    scenario,
    run: repeat,
    eotThreshold: EOT_THRESHOLD[mode],
    status: "counted",
    statusReason: "",
    failureCode: "",
    userTranscripts: transcripts,
    agentReply: premature
      ? "Sure, when would you like to come in?"
      : "Got it, I can book that for you.",
    turnCount: transcripts.length,
    cutOffPresses: premature ? 1 : 0,
    labels: {
      premature: premature ? "yes" : "no",
      transcriptionCorrect: "yes",
      responseAppropriate: premature ? "no" : "yes",
      replyCutShort: premature ? "yes" : "no"
    },
    timings: {
      speechStartToFinalMs: premature ? undefined : 3200 + scenario * 600,
      modelToFirstTextMs: 1300 + ((index * 91) % 900),
      ttsToFirstAudioMs: 480 + ((index * 53) % 120),
      finalInputToFirstAudioMs: 2000 + ((index * 91) % 900),
      outcome: premature ? "interrupted" : "completed"
    },
    perceived: {
      approxSpeechEndToFirstAudioMs: wait,
      approxPausesMs: scriptedPauses(script).map((s, i) => s * 1000 + ((index + i) % 3) * 150)
    },
    events: [],
    repaired: false,
    notes: "Synthetic example. Not a measurement."
  };
}

export const DEMO_TRIALS: Trial[] = [
  ...PLAN_ORDER.map((slot, i) => demoTrial(slot.scenario, slot.mode, slot.repeat, i)),
  {
    ...demoTrial(1, "standard", 0, 30),
    id: "demo-technical-1",
    run: 0,
    status: "technical_failure",
    statusReason: "Synthetic example of a call that failed before speech was recognized.",
    failureCode: "provider_quota",
    userTranscripts: [],
    agentReply: "",
    turnCount: 0
  }
];

export interface DemoReplay {
  mode: Mode;
  title: string;
  verdict: string;
  events: TrialEvent[];
}

/** Scenario 6 as an invented timeline in each mode, for the replay. */
export const DEMO_REPLAYS: DemoReplay[] = [
  {
    mode: "standard",
    title: "Standard (0.70)",
    verdict: "The agent answers after the first phrase. The speaker is still mid-request.",
    events: [
      { t: 0, type: "you", detail: "I need an appointment..." },
      { t: 1400, type: "pause", detail: "2 s pause" },
      { t: 2100, type: "turn committed", detail: "\"I need an appointment\"" },
      { t: 3400, type: "you", detail: "...for next Thursday..." },
      { t: 4300, type: "agent", detail: "Sure, when would you like to come in?" },
      { t: 4600, type: "reply cut off", detail: "The speaker was still talking" },
      { t: 6800, type: "you", detail: "...around eleven AM." }
    ]
  },
  {
    mode: "patient",
    title: "Patient (0.85)",
    verdict: "The agent waits through both pauses and answers the whole request.",
    events: [
      { t: 0, type: "you", detail: "I need an appointment..." },
      { t: 1400, type: "pause", detail: "2 s pause" },
      { t: 3400, type: "you", detail: "...for next Thursday..." },
      { t: 4700, type: "pause", detail: "2 s pause" },
      { t: 6700, type: "you", detail: "...around eleven AM." },
      { t: 8300, type: "turn committed", detail: "\"I need an appointment for next Thursday around eleven AM.\"" },
      { t: 10900, type: "agent", detail: "Got it, next Thursday at eleven works." }
    ]
  }
];
