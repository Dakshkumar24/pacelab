/**
 * The planned experiment: 6 scenarios x 2 modes x 2 repeats = 24 counted trials.
 * Only counted trials fill the matrix. Exploratory, excluded and technical
 * rows are kept beside it and never change these numbers.
 */
import type { Mode, Trial } from "./trial.ts";

export const SCENARIO_IDS = [1, 2, 3, 4, 5, 6];
export const PLAN_MODES: Mode[] = ["standard", "patient"];
export const REPEATS = 2;
export const PLANNED_TRIALS = SCENARIO_IDS.length * PLAN_MODES.length * REPEATS;

export interface Slot {
  scenario: number;
  mode: Mode;
  repeat: number;
}

/**
 * The run order. Repeat 1 walks the scenarios 1 to 6, repeat 2 walks them
 * 6 to 1, and the mode that goes first flips between the two repeats and
 * between neighbouring scenarios. So every scenario is run with each mode
 * first exactly once, and neither mode always gets the speaker's first,
 * least practised attempt.
 */
export const PLAN_ORDER: Slot[] = (() => {
  const slots: Slot[] = [];
  for (let repeat = 1; repeat <= REPEATS; repeat++) {
    const scenarios = repeat === 1 ? SCENARIO_IDS : [...SCENARIO_IDS].reverse();
    for (const scenario of scenarios) {
      const standardFirst = (scenario + repeat) % 2 === 0;
      const modes: Mode[] = standardFirst ? ["standard", "patient"] : ["patient", "standard"];
      for (const mode of modes) slots.push({ scenario, mode, repeat });
    }
  }
  return slots;
})();

export interface CellProgress {
  scenario: number;
  mode: Mode;
  counted: number;
  /** Planned repeats still to run. */
  missing: number;
}

export interface Progress {
  cells: CellProgress[];
  /** Counted trials that fill a planned slot. Never more than 24. */
  valid: number;
  planned: number;
  complete: boolean;
  next: Slot | null;
  exploratory: number;
  excluded: number;
  technicalFailures: number;
}

/** How many counted trials a scenario and mode already have. */
export function countedIn(trials: Trial[], scenario: number, mode: Mode): number {
  return trials.filter(
    (t) => t.status === "counted" && t.scenario === scenario && t.mode === mode
  ).length;
}

export function buildProgress(trials: Trial[]): Progress {
  const cells: CellProgress[] = [];
  for (const scenario of SCENARIO_IDS) {
    for (const mode of PLAN_MODES) {
      const counted = countedIn(trials, scenario, mode);
      cells.push({ scenario, mode, counted, missing: Math.max(0, REPEATS - counted) });
    }
  }
  const valid = cells.reduce((sum, c) => sum + Math.min(c.counted, REPEATS), 0);
  const next =
    PLAN_ORDER.find((slot) => countedIn(trials, slot.scenario, slot.mode) < slot.repeat) ?? null;
  return {
    cells,
    valid,
    planned: PLANNED_TRIALS,
    complete: valid === PLANNED_TRIALS,
    next,
    exploratory: trials.filter((t) => t.status === "exploratory").length,
    excluded: trials.filter((t) => t.status === "excluded").length,
    technicalFailures: trials.filter((t) => t.status === "technical_failure").length
  };
}

/**
 * The run number a new counted trial would get, or null when the scenario and
 * mode already have both planned repeats. A third run must be saved as exploratory.
 */
export function nextRun(trials: Trial[], scenario: number, mode: Mode): number | null {
  const counted = countedIn(trials, scenario, mode);
  return counted >= REPEATS ? null : counted + 1;
}
