import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canEnd,
  canStart,
  type CallEvent,
  type CallState,
  IDLE,
  reduce,
  wantsConnection
} from "../src/lib/callMachine.ts";
import {
  classifyMicError,
  classifyProviderResponse,
  describeFailure,
  sanitizeProviderText
} from "../src/lib/failures.ts";
import {
  type CallRow,
  decideReservation,
  nextUtcMidnight,
  settleStale,
  summarizeUsage,
  utcDay
} from "../src/lib/quota.ts";
import { DAILY_ATTEMPT_CAP, DAILY_CALL_CAP, MAX_CALL_MS, STARTUP_GRACE_MS } from "../src/config.ts";
import { checkPassphrase, mintToken, verifyToken } from "../src/lib/auth.ts";

function run(events: CallEvent[], from: CallState = IDLE): CallState {
  return events.reduce(reduce, from);
}

const NOW = Date.UTC(2026, 10, 15, 9, 0, 0);

function row(over: Partial<CallRow> = {}): CallRow {
  return {
    name: `trial-${Math.random().toString(16).slice(2)}`,
    day: utcDay(NOW),
    mode: "standard",
    state: "ended",
    reservedAt: NOW - 120_000,
    startedAt: NOW - 119_000,
    endedAt: NOW - 100_000,
    ttsChars: 0,
    failCode: "",
    ...over
  };
}

// --- Call lifecycle -------------------------------------------------------------

test("a normal call walks idle -> mic -> connecting -> listening -> responding -> idle", () => {
  let s = run([{ type: "START" }]);
  assert.equal(s.phase, "checking_mic");
  s = run([{ type: "MIC_OK" }], s);
  assert.equal(s.phase, "connecting");
  assert.ok(wantsConnection(s));
  s = run([{ type: "SDK_STATUS", status: "listening" }], s);
  assert.deepEqual([s.phase, s.wasLive], ["listening", true]);
  s = run([{ type: "SDK_STATUS", status: "thinking" }, { type: "SDK_STATUS", status: "speaking" }], s);
  assert.equal(s.phase, "responding");
  s = run([{ type: "SDK_STATUS", status: "listening" }, { type: "END" }], s);
  assert.equal(s.phase, "stopping");
  s = run([{ type: "STOPPED" }], s);
  assert.deepEqual([s.phase, s.wasLive], ["idle", true]);
});

test("rapid double Start and double End do nothing the second time", () => {
  const once = run([{ type: "START" }]);
  assert.equal(run([{ type: "START" }], once), once);
  const live = run([{ type: "MIC_OK" }, { type: "SDK_STATUS", status: "listening" }], once);
  const stopping = run([{ type: "END" }], live);
  assert.equal(run([{ type: "END" }], stopping), stopping);
  assert.equal(canStart(stopping), false);
  assert.equal(canEnd(stopping), false);
});

test("Start then End before the call is up cancels cleanly, and late events are ignored", () => {
  const cancelled = run([{ type: "START" }, { type: "MIC_OK" }, { type: "END" }]);
  assert.deepEqual(cancelled, IDLE);
  const late = run(
    [
      { type: "SDK_STATUS", status: "listening" },
      { type: "FAIL", code: "stt_startup_failed" },
      { type: "TIMEOUT" },
      { type: "MIC_OK" }
    ],
    cancelled
  );
  assert.deepEqual(late, IDLE);
});

test("a startup failure lands in failed without ever being live", () => {
  const s = run([{ type: "START" }, { type: "MIC_OK" }, { type: "FAIL", code: "provider_quota" }]);
  assert.deepEqual(s, { phase: "failed", failure: "provider_quota", wasLive: false });
  assert.equal(wantsConnection(s), false);
  assert.equal(canStart(s), true);
  assert.equal(run([{ type: "START" }], s).phase, "checking_mic");
});

test("a microphone refusal fails before any connection is wanted", () => {
  const s = run([{ type: "START" }, { type: "FAIL", code: "mic_denied" }]);
  assert.equal(s.phase, "failed");
  assert.equal(s.wasLive, false);
});

test("a startup timeout fails only while starting", () => {
  assert.equal(run([{ type: "START" }, { type: "MIC_OK" }, { type: "TIMEOUT" }]).failure, "startup_timeout");
  const live = run([{ type: "START" }, { type: "MIC_OK" }, { type: "SDK_STATUS", status: "listening" }]);
  assert.equal(run([{ type: "TIMEOUT" }], live), live);
});

test("a failure during a live call keeps the fact that it was live", () => {
  const s = run([
    { type: "START" },
    { type: "MIC_OK" },
    { type: "SDK_STATUS", status: "listening" },
    { type: "FAIL", code: "stt_connection_lost" }
  ]);
  assert.deepEqual(s, { phase: "failed", failure: "stt_connection_lost", wasLive: true });
});

test("the server ending the call moves a live call to stopping", () => {
  const s = run([
    { type: "START" },
    { type: "MIC_OK" },
    { type: "SDK_STATUS", status: "listening" },
    { type: "SDK_STATUS", status: "idle" }
  ]);
  assert.equal(s.phase, "stopping");
});

// --- Failure classification -----------------------------------------------------

test("provider answers are classified by status and wording", () => {
  assert.equal(classifyProviderResponse(429, ""), "provider_quota");
  assert.equal(
    classifyProviderResponse(400, "you have used up your daily free allocation of 10,000 neurons"),
    "provider_quota"
  );
  assert.equal(classifyProviderResponse(401, ""), "provider_auth");
  assert.equal(classifyProviderResponse(503, "upstream"), "provider_unavailable");
  assert.equal(classifyProviderResponse(undefined, ""), "provider_error");
});

test("microphone errors map to actionable failures", () => {
  assert.equal(classifyMicError("NotAllowedError"), "mic_denied");
  assert.equal(classifyMicError("NotFoundError"), "mic_missing");
  assert.equal(classifyMicError("NotReadableError"), "mic_busy");
  assert.equal(classifyMicError("Weird"), "unknown");
});

test("every failure has a message and an action, and unknown codes fall back", () => {
  assert.equal(describeFailure("nonsense").code, "unknown");
  const q = describeFailure("provider_quota");
  assert.match(q.message, /allocation/);
  assert.equal(q.retryable, false);
  assert.ok(q.action.length > 10);
});

test("provider text is shortened and stripped of anything token-like", () => {
  const out = sanitizeProviderText(
    `error   Bearer abc.def-123 key ${"k".repeat(40)} ${"x ".repeat(400)}`
  );
  assert.ok(!out.includes("abc.def-123"));
  assert.ok(!out.includes("k".repeat(40)));
  assert.ok(out.length <= 300);
});

// --- Quota ----------------------------------------------------------------------

test("a new call is allowed when nothing is open and the cap has room", () => {
  assert.deepEqual(decideReservation([row()], "trial-new", "standard"), { allowed: true, reuse: false });
});

test("the same call reconnecting reuses its slot; a finished call cannot be reopened", () => {
  const open = row({ name: "trial-a", state: "established", endedAt: null });
  assert.deepEqual(decideReservation([open], "trial-a", "standard"), { allowed: true, reuse: true });
  const wrongMode = decideReservation([open], "trial-a", "patient");
  assert.equal(wrongMode.allowed, false);
  for (const state of ["ended", "failed"] as const) {
    const d = decideReservation([row({ name: "trial-b", state })], "trial-b", "standard");
    assert.ok(!d.allowed && d.code === "call_finished");
  }
});

test("a second call cannot start while one is open", () => {
  for (const state of ["reserved", "established"] as const) {
    const d = decideReservation([row({ state, endedAt: null })], "trial-new", "patient");
    assert.ok(!d.allowed && d.code === "call_in_progress" && d.status === 409);
  }
});

test("failed starts give their slot back but still count as attempts", () => {
  const failed = Array.from({ length: DAILY_CALL_CAP + 5 }, () => row({ state: "failed", startedAt: null }));
  assert.equal(decideReservation(failed, "trial-new", "standard").allowed, true);
  const tooMany = Array.from({ length: DAILY_ATTEMPT_CAP }, () => row({ state: "failed", startedAt: null }));
  const d = decideReservation(tooMany, "trial-new", "standard");
  assert.ok(!d.allowed && d.code === "attempt_cap" && d.status === 429);
});

test("the daily cap counts established and ended calls", () => {
  const full = Array.from({ length: DAILY_CALL_CAP }, () => row());
  const d = decideReservation(full, "trial-new", "standard");
  assert.ok(!d.allowed && d.code === "daily_cap" && d.status === 429);
  assert.equal(decideReservation(full.slice(1), "trial-new", "standard").allowed, true);
});

test("silent rows are settled by the clock", () => {
  const stuckStart = row({ state: "reserved", reservedAt: NOW - STARTUP_GRACE_MS - 1, startedAt: null, endedAt: null });
  const freshStart = row({ state: "reserved", reservedAt: NOW - 1000, startedAt: null, endedAt: null });
  const stuckCall = row({
    state: "established",
    startedAt: NOW - MAX_CALL_MS - STARTUP_GRACE_MS - 1,
    endedAt: null
  });
  const changed = settleStale([stuckStart, freshStart, stuckCall, row()], NOW);
  assert.equal(changed.length, 2);
  assert.deepEqual(
    changed.map((r) => [r.state, r.failCode]),
    [
      ["failed", "startup_timeout"],
      ["ended", ""]
    ]
  );
  assert.equal(changed[1].endedAt, stuckCall.startedAt! + MAX_CALL_MS);
});

test("usage separates attempts, calls and failures, and estimates neurons from list prices", () => {
  const rows = [
    row({ startedAt: NOW - 60_000, endedAt: NOW, ttsChars: 1000 }),
    row({ state: "failed", startedAt: null, endedAt: NOW, failCode: "provider_quota" })
  ];
  const u = summarizeUsage(rows, NOW);
  assert.deepEqual([u.used, u.attempts, u.failed], [1, 2, 1]);
  assert.equal(u.estimatedNeurons, 700 + 1364);
  assert.equal(u.providerExhausted, true);
  assert.equal(u.resetsAt, Date.UTC(2026, 10, 16));
  assert.equal(nextUtcMidnight(Date.UTC(2026, 11, 31, 23, 59)), Date.UTC(2027, 0, 1));
});

// --- Authentication -------------------------------------------------------------

test("session tokens verify with the signing key, and fail when forged, expired or missing", async () => {
  const key = "test-signing-key-not-a-real-secret";
  const token = await mintToken(key, 60_000);
  assert.equal((await verifyToken(token, key)).ok, true);
  assert.equal((await verifyToken(token, "another-key")).ok, false);
  assert.equal((await verifyToken(`${token}x`, key)).ok, false);
  assert.equal((await verifyToken(null, key)).ok, false);
  const expired = await mintToken(key, -1000);
  assert.equal((await verifyToken(expired, key)).ok, false);
});

test("the passphrase check accepts only the exact passphrase", async () => {
  const key = "test-signing-key-not-a-real-secret";
  assert.equal(await checkPassphrase("open sesame", "open sesame", key), true);
  assert.equal(await checkPassphrase("open sesam", "open sesame", key), false);
  assert.equal(await checkPassphrase("", "open sesame", key), false);
});
