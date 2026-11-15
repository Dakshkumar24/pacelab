/**
 * The six scripted scenarios. Each script is a list of parts: words to say,
 * and pauses to hold. Pauses are held by a person watching a visual timer, so
 * their real length is approximate. All content is fictional.
 */
export type ScriptPart = { say: string } | { pauseSeconds: number };

export interface Scenario {
  id: number;
  name: string;
  /** What the scenario is for, in a few words. */
  tests: string;
  /** What a reviewer should look for when labelling. */
  intent: string;
  parts: ScriptPart[];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 1,
    name: "Fluent baseline",
    tests: "No pauses",
    intent: "Basic recognition, turn completion and an appropriate reply.",
    parts: [{ say: "Can I book a cleaning for Tuesday afternoon?" }]
  },
  {
    id: 2,
    name: "Short pause",
    tests: "One 2-second pause",
    intent: "Does a short hesitation trigger an early reply?",
    parts: [
      { say: "I'd like to schedule a cleaning for..." },
      { pauseSeconds: 2 },
      { say: "...Thursday afternoon." }
    ]
  },
  {
    id: 3,
    name: "Long pause",
    tests: "One 3-second pause",
    intent: "Does a longer mid-sentence silence trigger an early reply?",
    parts: [
      { say: "Could you book my appointment for..." },
      { pauseSeconds: 3 },
      { say: "...Friday at ten in the morning?" }
    ]
  },
  {
    id: 4,
    name: "Hesitations",
    tests: "Fillers and a restart",
    intent: "Are fillers and restarts handled as one request?",
    parts: [{ say: "Um, I was thinking, uh, Wednesday—no, Thursday afternoon." }]
  },
  {
    id: 5,
    name: "Self-correction",
    tests: "A corrected detail",
    intent: "Does the reply follow the corrected details (Tuesday at four)?",
    parts: [{ say: "Please book Monday at two PM—sorry, I meant Tuesday at four PM." }]
  },
  {
    id: 6,
    name: "Multiple pauses",
    tests: "Two 2-second pauses",
    intent: "Several chances to end the turn early inside one request.",
    parts: [
      { say: "I need an appointment..." },
      { pauseSeconds: 2 },
      { say: "...for next Thursday..." },
      { pauseSeconds: 2 },
      { say: "...around eleven AM." }
    ]
  }
];

export function scenarioById(id: number): Scenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/** The script as one line of text, with pauses written as [2 s]. */
export function scriptText(s: Scenario): string {
  return s.parts
    .map((p) => ("say" in p ? p.say : `[${p.pauseSeconds} s]`))
    .join(" ");
}

/** The scripted pause lengths, in order. */
export function scriptedPauses(s: Scenario): number[] {
  return s.parts.flatMap((p) => ("pauseSeconds" in p ? [p.pauseSeconds] : []));
}
