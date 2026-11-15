import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildProgress,
  nextRun,
  PLAN_ORDER,
  PLANNED_TRIALS
} from "../src/lib/experiment.ts";
import { buildReport, MIN_JUDGED_PER_MODE, percent, spread } from "../src/lib/report.ts";
import type { Trial } from "../src/lib/trial.ts";
import { counted, trial, withStatus } from "./helpers.ts";

function fullMatrix(premature: (t: { scenario: number; mode: string }) => boolean): Trial[] {
  return PLAN_ORDER.map((slot) =>
    counted(slot.scenario, slot.mode, {
      run: slot.repeat,
      labels: {
        premature: premature(slot) ? "yes" : "no",
        transcriptionCorrect: "yes",
        responseAppropriate: premature(slot) ? "no" : "yes",
        replyCutShort: "no"
      }
    })
  );
}

test("the plan has 24 slots, two per cell, and balances which mode goes first", () => {
  assert.equal(PLAN_ORDER.length, PLANNED_TRIALS);
  assert.equal(PLANNED_TRIALS, 24);
  const keys = new Set(PLAN_ORDER.map((s) => `${s.scenario}-${s.mode}-${s.repeat}`));
  assert.equal(keys.size, 24);
  for (const scenario of [1, 2, 3, 4, 5, 6]) {
    const first = [1, 2].map(
      (repeat) => PLAN_ORDER.find((s) => s.scenario === scenario && s.repeat === repeat)!.mode
    );
    assert.notEqual(first[0], first[1], `scenario ${scenario} leads with both modes`);
  }
  const standardFirst = [1, 2, 3, 4, 5, 6].filter(
    (sc) => PLAN_ORDER.find((s) => s.scenario === sc && s.repeat === 1)!.mode === "standard"
  );
  assert.equal(standardFirst.length, 3);
});

test("an empty store starts at the first planned slot", () => {
  const p = buildProgress([]);
  assert.equal(p.valid, 0);
  assert.equal(p.complete, false);
  assert.deepEqual(p.next, PLAN_ORDER[0]);
  assert.equal(p.cells.length, 12);
});

test("only counted trials move progress or the next slot", () => {
  const first = PLAN_ORDER[0];
  const noise = [
    withStatus("exploratory", { scenario: first.scenario, mode: first.mode }),
    withStatus("excluded", { scenario: first.scenario, mode: first.mode }),
    withStatus("technical_failure", { scenario: first.scenario, mode: first.mode })
  ];
  const p = buildProgress(noise);
  assert.equal(p.valid, 0);
  assert.deepEqual(p.next, first);
  assert.equal(p.exploratory + p.excluded + p.technicalFailures, 3);

  const after = buildProgress([...noise, counted(first.scenario, first.mode)]);
  assert.equal(after.valid, 1);
  assert.deepEqual(after.next, PLAN_ORDER[1]);
});

test("a cell holds two counted trials and refuses a third run number", () => {
  const two = [counted(3, "patient"), counted(3, "patient")];
  assert.equal(nextRun([], 3, "patient"), 1);
  assert.equal(nextRun(two.slice(0, 1), 3, "patient"), 2);
  assert.equal(nextRun(two, 3, "patient"), null);
  assert.equal(buildProgress(two).valid, 2);
});

test("a full matrix is complete with nothing next", () => {
  const p = buildProgress(fullMatrix(() => false));
  assert.equal(p.valid, 24);
  assert.equal(p.complete, true);
  assert.equal(p.next, null);
});

test("rates use judged trials as the denominator, never unknowns or uncounted rows", () => {
  const rows = [
    counted(2, "standard", { labels: { ...trial().labels, premature: "yes" } }),
    counted(2, "standard", { labels: { ...trial().labels, premature: "unknown" } }),
    withStatus("exploratory", { scenario: 2, labels: { ...trial().labels, premature: "yes" } }),
    withStatus("technical_failure", { scenario: 2 }),
    withStatus("excluded", { scenario: 2 })
  ];
  const cell = buildReport(rows).scenarios[1].standard;
  assert.equal(cell.trials, 2);
  assert.deepEqual(cell.premature, { yes: 1, judged: 1, unknown: 1 });
  assert.equal(percent(cell.premature), 100);
  assert.deepEqual(cell.succeeded, { yes: 0, judged: 1, unknown: 1 });
  assert.equal(cell.technicalFailures, 1);
  assert.equal(cell.excluded, 1);
  assert.equal(cell.exploratory, 1);
  assert.equal(cell.prematureExamples.length, 1);
});

test("a rate with nothing judged has no percentage", () => {
  assert.equal(percent({ yes: 0, judged: 0, unknown: 3 }), null);
  const empty = buildReport([]).totals.patient;
  assert.equal(percent(empty.premature), null);
  assert.equal(empty.finalInputToFirstAudio.median, null);
});

test("an SDK split is reported as a fact, separate from the manual premature label", () => {
  const split = counted(6, "standard", { userTranscripts: ["I need", "for Thursday"], turnCount: 2 });
  const cell = buildReport([split]).scenarios[5].standard;
  assert.equal(cell.sdkSplits, 1);
  assert.equal(cell.premature.yes, 0);
  assert.equal(cell.speechStartToFinal.n, 0, "split trials are left out of speech-start timing");
});

test("spread ignores missing values and reports median, min and max", () => {
  assert.deepEqual(spread([300, undefined, 100, 200]), { n: 3, median: 200, min: 100, max: 300 });
  assert.deepEqual(spread([100, 200]), { n: 2, median: 150, min: 100, max: 200 });
  assert.deepEqual(spread([]), { n: 0, median: null, min: null, max: null });
});

test("the decision is 'insufficient evidence' until both modes have enough judged trials", () => {
  const few = PLAN_ORDER.slice(0, MIN_JUDGED_PER_MODE).map((s) => counted(s.scenario, s.mode));
  const d = buildReport(few).decision;
  assert.equal(d.verdict, "insufficient");
  assert.equal(d.headline, "Insufficient evidence");
});

test("the decision names the better mode only when the gap is more than one trial", () => {
  const big = buildReport(fullMatrix((s) => s.mode === "standard" && [2, 3, 6].includes(s.scenario)));
  assert.equal(big.decision.verdict, "patient_fewer");
  assert.match(big.decision.points.find((p) => p.label === "Confidence")!.text, /Directional/);

  const one = buildReport(fullMatrix((s) => s.mode === "standard" && s.scenario === 6 && false));
  assert.equal(one.decision.verdict, "no_clear_difference");

  let flipped = 0;
  const single = buildReport(
    fullMatrix((s) => s.mode === "standard" && s.scenario === 6 && flipped++ === 0)
  );
  assert.equal(single.decision.verdict, "no_clear_difference");
});
