import assert from "node:assert/strict";
import { test } from "node:test";
import { SCENARIOS, scriptedPauses, scriptText } from "../src/lib/scenarios.ts";
import {
  CSV_COLUMNS,
  csvCell,
  trialsToCsv,
  turnSucceeded,
  upgradeTrial,
  validateTrial
} from "../src/lib/trial.ts";
import { trial, withStatus } from "./helpers.ts";

test("there are six scenarios with the scripted pauses", () => {
  assert.deepEqual(SCENARIOS.map((s) => s.id), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(SCENARIOS.map(scriptedPauses), [[], [2], [3], [], [], [2, 2]]);
  assert.equal(
    scriptText(SCENARIOS[5]),
    "I need an appointment... [2 s] ...for next Thursday... [2 s] ...around eleven AM."
  );
  for (const s of SCENARIOS) assert.ok(s.intent.length > 10);
});

test("a well-formed counted trial validates", () => {
  const out = validateTrial(trial());
  assert.equal(typeof out, "object");
});

test("the server, not the client, sets the run number and the turn count", () => {
  const out = validateTrial(trial({ run: 7, turnCount: 9, userTranscripts: ["a", "b"] }));
  assert.ok(typeof out === "object");
  assert.equal(out.run, 0);
  assert.equal(out.turnCount, 2);
});

test("an empty session cannot be saved as a counted trial", () => {
  const out = validateTrial(trial({ userTranscripts: [], agentReply: "" }));
  assert.match(String(out), /technical failure/);
  const blank = validateTrial(trial({ userTranscripts: ["   "] }));
  assert.equal(typeof blank, "string");
});

test("a technical failure needs a description and carries no judgments", () => {
  const missing = validateTrial(withStatus("technical_failure", { statusReason: "" }));
  assert.equal(typeof missing, "string");
  const out = validateTrial(
    withStatus("technical_failure", { userTranscripts: [], failureCode: "provider_quota" })
  );
  assert.ok(typeof out === "object");
  assert.deepEqual(Object.values(out.labels), ["unknown", "unknown", "unknown", "unknown"]);
});

test("an excluded trial needs a meaningful reason", () => {
  assert.equal(typeof validateTrial(withStatus("excluded", { statusReason: "bad" })), "string");
  assert.equal(typeof validateTrial(withStatus("excluded")), "object");
});

test("a counted trial must answer every label, and may answer unknown", () => {
  const t = trial() as unknown as Record<string, unknown>;
  t.labels = { premature: "no", transcriptionCorrect: "yes", responseAppropriate: "yes" };
  assert.match(String(validateTrial(t)), /replyCutShort/);
  const unsure = validateTrial(
    trial({ labels: { ...trial().labels, premature: "unknown" } })
  );
  assert.equal(typeof unsure, "object");
});

test("bad ids, modes and scenarios are rejected, and demo ids can never be stored", () => {
  assert.equal(typeof validateTrial(trial({ id: "x" })), "string");
  assert.equal(typeof validateTrial(trial({ id: "demo-standard-1-1" })), "string");
  assert.equal(typeof validateTrial({ ...trial(), mode: "fast" }), "string");
  assert.equal(typeof validateTrial(trial({ scenario: 7 })), "string");
  assert.equal(typeof validateTrial(null), "string");
});

test("a split request is not a premature response unless a person says so", () => {
  const t = trial({ userTranscripts: ["I need an appointment", "for Thursday"], turnCount: 2 });
  assert.equal(t.labels.premature, "no");
  assert.equal(turnSucceeded(t), true);
});

test("success is unknown when any core label is unknown, and false after a typed repair", () => {
  assert.equal(turnSucceeded(trial({ labels: { ...trial().labels, premature: "unknown" } })), null);
  assert.equal(turnSucceeded(trial({ repaired: true })), false);
  assert.equal(turnSucceeded(trial({ labels: { ...trial().labels, premature: "yes" } })), false);
});

test("csv cells neutralise spreadsheet formulas and quote separators", () => {
  assert.equal(csvCell("=HYPERLINK(\"http://x\")"), "\"'=HYPERLINK(\"\"http://x\"\")\"");
  assert.equal(csvCell("+1"), "'+1");
  assert.equal(csvCell("-1"), "'-1");
  assert.equal(csvCell("@cmd"), "'@cmd");
  assert.equal(csvCell("a,b"), "\"a,b\"");
  assert.equal(csvCell("line\nbreak"), "\"line\nbreak\"");
  assert.equal(csvCell(-5), "-5");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(true), "1");
});

test("csv has one header, one row per trial, and a column for every header", () => {
  const csv = trialsToCsv([trial(), trial({ notes: "=SUM(A1)" })]);
  const lines = csv.trim().split("\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0].split(",").length, CSV_COLUMNS.length);
  assert.ok(lines[2].endsWith("'=SUM(A1)"));
});

test("rows saved before schema 2 are read as exploratory, never counted", () => {
  const old = {
    id: "selftest-1",
    mode: "patient",
    scenario: 6,
    userTranscripts: ["hello"],
    labels: { prematureInterruption: true, transcriptionCorrect: true, responseAppropriate: false },
    excluded: false,
    exploratory: false
  };
  const t = upgradeTrial(old);
  assert.equal(t.status, "exploratory");
  assert.equal(t.labels.premature, "yes");
  assert.equal(t.labels.responseAppropriate, "no");
  assert.equal(t.labels.replyCutShort, "unknown");
});
