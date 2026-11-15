import type { Capture, Line } from "./useCall";

/**
 * Development-only fixtures for reviewing the Workbench's live and labeling
 * states without a microphone or a model. Reached with `?mock=live` or
 * `?mock=label` on the Vite dev server only: every caller guards on
 * `import.meta.env.DEV`, so production builds drop this module entirely.
 * Nothing here is saved, and the UI marks the state as mocked.
 */
export type MockKind = "live" | "label";

/** Mocks show scenario 2, which has one pause. */
export const MOCK_SCENARIO = 2;

export function mockKind(): MockKind | null {
  const v = new URLSearchParams(location.search).get("mock");
  return v === "live" || v === "label" ? v : null;
}

const LINES: Line[] = [
  { role: "user", text: "I'd like to schedule a cleaning for" },
  { role: "assistant", text: "Sure, what day works for you?" }
];

export const MOCK_LIVE = {
  phase: "listening" as const,
  lines: LINES.slice(0, 1),
  interim: "Thursday after",
  audioLevel: 0.11,
  silenceSince: null as number | null,
  pausesHeld: 1
};

export const MOCK_CAPTURE: Capture = {
  name: "trial-00000000-0000-4000-8000-000000000000",
  mode: "standard",
  scenario: 2,
  lines: [...LINES, { role: "user", text: "Thursday afternoon." }],
  turns: [
    {
      turnId: "mock",
      source: "speech",
      outcome: "completed",
      speechStartToFinalMs: 2210,
      finalInputToFirstAudioMs: 1180,
      modelToFirstTextMs: 640,
      ttsToFirstAudioMs: 390
    }
  ],
  events: [
    { t: 0, type: "listening" },
    { t: 900, type: "speech_start" },
    { t: 3110, type: "turn_committed", detail: "I'd like to schedule a cleaning for" },
    { t: 4290, type: "first_audio" }
  ],
  cutOffs: 1,
  repaired: false,
  perceivedMs: 1420,
  pausesMs: [1900],
  wasLive: true,
  failure: null,
  failureDetail: ""
};
