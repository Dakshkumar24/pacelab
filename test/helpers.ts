import type { Mode, Trial, TrialStatus } from "../src/lib/trial.ts";

let seq = 0;

/** A valid call name, as the app makes them. */
export function callName(): string {
  seq += 1;
  return `trial-00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
}

/** A well-formed trial, with any fields overridden. */
export function trial(over: Partial<Trial> = {}): Trial {
  return {
    schema: 2,
    id: callName(),
    createdAt: 1_700_000_000_000 + seq,
    mode: "standard",
    scenario: 1,
    run: 1,
    eotThreshold: 0.7,
    status: "counted",
    statusReason: "",
    failureCode: "",
    userTranscripts: ["Can I book a cleaning for Tuesday afternoon?"],
    agentReply: "Sure, what time works?",
    turnCount: 1,
    cutOffPresses: 0,
    labels: {
      premature: "no",
      transcriptionCorrect: "yes",
      responseAppropriate: "yes",
      replyCutShort: "no"
    },
    timings: { finalInputToFirstAudioMs: 2000, modelToFirstTextMs: 1300, outcome: "completed" },
    perceived: { approxSpeechEndToFirstAudioMs: 2400, approxPausesMs: [] },
    events: [],
    repaired: false,
    notes: "",
    ...over
  };
}

export function counted(scenario: number, mode: Mode, over: Partial<Trial> = {}): Trial {
  return trial({ scenario, mode, ...over });
}

export function withStatus(status: TrialStatus, over: Partial<Trial> = {}): Trial {
  return trial({ status, statusReason: "microphone dropped out mid-call", ...over });
}
