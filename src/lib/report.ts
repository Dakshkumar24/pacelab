/**
 * Turn Failure Report. Per scenario, both modes side by side.
 *
 * Counts come from manual labels or the SDK's turn count. Timings come from
 * the SDK (server clock). The perceived wait is a browser-clock approximation
 * and is reported in its own column, never blended with SDK timings.
 *
 * Exploratory and excluded trials are kept in storage but left out of here.
 */

import { type Mode, type Trial, isPremature, isSuccessfulTurn } from "./trial";

export interface Spread {
  n: number;
  median: number | null;
  worst: number | null;
}

export interface ModeCell {
  mode: Mode;
  trials: number;
  successfulTurns: number;
  /** Manual label or SDK split, either one. */
  prematureTurns: number;
  /** Of those, how many the SDK measured as a split (more than one committed turn). */
  prematureMeasured: number;
  transcriptionCorrect: number;
  responseAppropriate: number;
  repairs: number;
  /** SDK. Only trials answered in one turn, so both modes measure the whole request. */
  speechStartToFinal: Spread;
  /** SDK. Finalized transcript to first audio sent. */
  finalInputToFirstAudio: Spread;
  /** SDK. Model invocation to first text. */
  modelToFirstText: Spread;
  /** SDK. First TTS call to first audio sent. */
  ttsToFirstAudio: Spread;
  /** Approximate, browser clock. */
  perceivedWait: Spread;
}

export interface ScenarioRow {
  scenario: number;
  standard: ModeCell;
  patient: ModeCell;
  /**
   * Patient minus Standard median speechStartToFinal, over single-turn trials.
   * Directional only: a live speaker's pacing varies between runs.
   */
  addedDelayDirectionalMs: number | null;
}

export interface Report {
  scenarios: ScenarioRow[];
  totals: { standard: ModeCell; patient: ModeCell };
  counted: number;
  excluded: number;
  exploratory: number;
}

function spread(values: (number | undefined)[]): Spread {
  const v = values.filter((x): x is number => typeof x === "number" && x >= 0);
  if (v.length === 0) return { n: 0, median: null, worst: null };
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  return { n: v.length, median, worst: s[s.length - 1] };
}

function cell(mode: Mode, trials: Trial[]): ModeCell {
  const singleTurn = trials.filter((t) => !isPremature(t));
  return {
    mode,
    trials: trials.length,
    successfulTurns: trials.filter(isSuccessfulTurn).length,
    prematureTurns: trials.filter(isPremature).length,
    prematureMeasured: trials.filter((t) => t.turnCount > 1).length,
    transcriptionCorrect: trials.filter((t) => t.labels.transcriptionCorrect).length,
    responseAppropriate: trials.filter((t) => t.labels.responseAppropriate).length,
    repairs: trials.filter((t) => t.repaired).length,
    speechStartToFinal: spread(singleTurn.map((t) => t.timings.speechStartToFinalMs)),
    finalInputToFirstAudio: spread(trials.map((t) => t.timings.finalInputToFirstAudioMs)),
    modelToFirstText: spread(trials.map((t) => t.timings.modelToFirstTextMs)),
    ttsToFirstAudio: spread(trials.map((t) => t.timings.ttsToFirstAudioMs)),
    perceivedWait: spread(trials.map((t) => t.perceived?.approxSpeechEndToFirstAudioMs))
  };
}

export function buildReport(all: Trial[]): Report {
  const counted = all.filter((t) => !t.excluded && !t.exploratory);
  const scenarios = [...new Set(counted.map((t) => t.scenario))].sort((a, b) => a - b);
  const rows = scenarios.map((scenario) => {
    const inScenario = counted.filter((t) => t.scenario === scenario);
    const standard = cell("standard", inScenario.filter((t) => t.mode === "standard"));
    const patient = cell("patient", inScenario.filter((t) => t.mode === "patient"));
    const a = standard.speechStartToFinal.median;
    const b = patient.speechStartToFinal.median;
    return {
      scenario,
      standard,
      patient,
      addedDelayDirectionalMs: a !== null && b !== null ? b - a : null
    };
  });
  return {
    scenarios: rows,
    totals: {
      standard: cell("standard", counted.filter((t) => t.mode === "standard")),
      patient: cell("patient", counted.filter((t) => t.mode === "patient"))
    },
    counted: counted.length,
    excluded: all.filter((t) => t.excluded).length,
    exploratory: all.filter((t) => t.exploratory && !t.excluded).length
  };
}
