/**
 * The six scripted scenarios. "[2s]" marks a pause the speaker holds, timed by
 * eye on a clock. Draft wording: finalized in Phase 5 before the batch.
 * All content is fictional.
 */
export interface Scenario {
  id: number;
  name: string;
  tests: string;
  script: string;
}

export const SCENARIOS: Scenario[] = [
  {
    id: 1,
    name: "Fluent",
    tests: "Baseline, no pauses",
    script: "Can I book a cleaning for Tuesday afternoon?"
  },
  {
    id: 2,
    name: "Short pause",
    tests: "One 2-second hesitation mid-phrase",
    script: "I'd like to book a cleaning [2s] for Tuesday afternoon."
  },
  {
    id: 3,
    name: "Long pause",
    tests: "One 3-second pause mid-phrase",
    script: "I need to move my appointment [3s] to Friday morning."
  },
  {
    id: 4,
    name: "Hesitations",
    tests: "Fillers and restarts",
    script: "Um, I need to, uh, reschedule my, my checkup to next week."
  },
  {
    id: 5,
    name: "Self-correction",
    tests: "Changing a detail mid-sentence",
    script: "Can I come in on Tuesday, no, Wednesday at two?"
  },
  {
    id: 6,
    name: "Multiple pauses",
    tests: "Repeated risk inside one request",
    script: "I need an appointment [2s] for next Thursday [2s] around eleven AM."
  }
];
