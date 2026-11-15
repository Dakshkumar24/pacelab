/**
 * API smoke test against a LOCAL dev server. It signs in, reserves calls,
 * saves trials and deletes them, so it refuses to run against anything but
 * localhost. See docs/TESTING.md for how to start the server without the AI
 * binding, so no Workers AI usage is possible.
 *
 *   PACELAB_URL=http://localhost:5199 PACELAB_TEST_PASSPHRASE=... node scripts/smoke-local.mjs
 */
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const WebSocket = require("ws");
const B = process.env.PACELAB_URL ?? "http://localhost:5199";
const PASS = process.env.PACELAB_TEST_PASSPHRASE ?? "local-test-only";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(B)) {
  console.error(`Refusing to run against ${B}: this script deletes trials. Use a local dev server.`);
  process.exit(2);
}
const O = { origin: B, "content-type": "application/json" };
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); };
const j = async (r) => { try { return await r.json(); } catch { return {}; } };
const uuid = () => `trial-${crypto.randomUUID()}`;

// --- auth
let r = await fetch(`${B}/api/usage`);
check("no cookie -> 401", r.status === 401);
r = await fetch(`${B}/api/session`, { method: "POST", headers: O, body: JSON.stringify({ passphrase: "wrong" }) });
check("wrong passphrase -> 401", r.status === 401);
r = await fetch(`${B}/api/session`, { method: "POST", headers: { ...O, origin: "https://evil.example" }, body: JSON.stringify({ passphrase: PASS }) });
check("cross-site sign-in -> 403", r.status === 403);
r = await fetch(`${B}/api/session`, { method: "POST", headers: O, body: JSON.stringify({ passphrase: PASS }) });
const cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
check("right passphrase -> cookie", r.ok && cookie.startsWith("pacelab_session="), "");
check("cookie is HttpOnly SameSite=Strict", /HttpOnly/.test(r.headers.get("set-cookie")) && /SameSite=Strict/.test(r.headers.get("set-cookie")));
const H = { ...O, cookie };
const get = (p) => fetch(`${B}${p}`, { headers: { cookie } });
const post = (p, body, h = H) => fetch(`${B}${p}`, { method: "POST", headers: h, body: JSON.stringify(body) });

// --- internal routes are not reachable
for (const p of ["call-reserve", "call-event", "call-check", "auth-ok", "auth-failed"]) {
  r = await post(`/api/${p}`, { name: uuid(), mode: "standard", event: "established" });
  check(`internal /api/${p} -> 404`, r.status === 404);
}
r = await post("/api/trial", { id: "x" }, { ...H, origin: "https://evil.example" });
check("cross-site write with cookie -> 403", r.status === 403);

// --- usage starts clean
let u = await j(await get("/api/usage"));
check("usage shape", u.cap === 30 && u.attemptCap === 90 && u.neuronBudget === 10000, JSON.stringify(u));
const used0 = u.used, attempts0 = u.attempts, failed0 = u.failed;

// --- websocket needs a reservation
const ws = (path, headers = { cookie, origin: B }) => new Promise((resolve) => {
  const s = new WebSocket(`${B.replace('http', 'ws')}${path}`, { headers });
  const msgs = [];
  s.on("unexpected-response", (_q, res) => resolve({ status: res.statusCode, msgs }));
  s.on("error", () => resolve({ status: -1, msgs }));
  s.on("open", () => { s.send(JSON.stringify({ type: "hello", protocol_version: 1 })); s.send(JSON.stringify({ type: "start_call" })); });
  s.on("message", (d, bin) => { if (!bin) msgs.push(JSON.parse(d.toString())); });
  setTimeout(() => { s.close(); setTimeout(() => resolve({ status: 101, msgs }), 500); }, 2500);
});
const n0 = uuid();
let w = await ws(`/agents/standard-voice-agent/${n0}`);
check("websocket without reservation refused", w.status !== 101);
w = await ws(`/agents/standard-voice-agent/${n0}`, { cookie: "", origin: B });
check("websocket without cookie refused", w.status !== 101);

// --- reserve, then the call fails to start (no AI binding locally): slot is given back
const n1 = uuid();
r = await post("/api/call", { name: n1, mode: "standard" });
check("reserve -> ok", r.ok);
r = await post("/api/call", { name: uuid(), mode: "patient" });
let b = await j(r);
check("second call while one is open -> 409 call_in_progress", r.status === 409 && b.code === "call_in_progress");
w = await ws(`/agents/patient-voice-agent/${n1}`);
check("websocket on the wrong mode's agent refused", w.status !== 101);
w = await ws(`/agents/standard-voice-agent/${n1}`, { cookie, origin: "https://evil.example" });
check("cross-site websocket refused", w.status !== 101);
w = await ws(`/agents/standard-voice-agent/${n1}`);
const types = w.msgs.map((m) => m.type);
const custom = w.msgs.find((m) => m.type === "pacelab_failure");
const sdkErr = w.msgs.find((m) => m.type === "error");
check("startup failure: custom cause sent before SDK error", !!custom && !!sdkErr && types.indexOf("pacelab_failure") < types.indexOf("error"), JSON.stringify({ custom, sdkErr }));
check("no diagnostic messages forwarded to the browser", !types.includes("diagnostic"));
await new Promise((x) => setTimeout(x, 800));
u = await j(await get("/api/usage"));
check("failed start: attempt counted, slot given back", u.attempts === attempts0 + 1 && u.used === used0 && u.failed === failed0 + 1, JSON.stringify(u));
r = await post("/api/call", { name: n1, mode: "standard" });
b = await j(r);
check("a finished call cannot be reopened -> 409", r.status === 409 && b.code === "call_finished");
w = await ws(`/agents/standard-voice-agent/${n1}`);
check("websocket for a finished call refused", w.status !== 101);

// --- cancel before connecting frees the slot at once
const n2 = uuid();
await post("/api/call", { name: n2, mode: "patient" });
await post("/api/call-cancel", { name: n2 });
const n3 = uuid();
r = await post("/api/call", { name: n3, mode: "patient" });
check("after cancel, a new call can start immediately", r.ok);
await post("/api/call-cancel", { name: n3 });
r = await post("/api/call", { name: "bad", mode: "standard" });
check("bad call name -> 400", r.status === 400);

// --- trials
const labels = { premature: "no", transcriptionCorrect: "yes", responseAppropriate: "yes", replyCutShort: "no" };
const t = (over) => ({ id: uuid(), mode: "standard", scenario: 1, status: "counted", statusReason: "", userTranscripts: ["Can I book a cleaning?"], agentReply: "Sure.", labels, timings: {}, perceived: {}, events: [], eotThreshold: 0.7, ...over });
r = await post("/api/trial", t({ userTranscripts: [] }));
check("empty session cannot be counted -> 400", r.status === 400, (await j(r)).error);
r = await post("/api/trial", t({ id: "demo-standard-1-1" }));
check("demo id cannot be stored -> 400", r.status === 400);
const tf = t({ status: "technical_failure", statusReason: "Workers AI refused to start speech recognition.", failureCode: "provider_quota", userTranscripts: [], labels: {} });
r = await post("/api/trial", tf);
check("technical failure saves", r.ok);
r = await post("/api/trial", tf);
check("same call saved twice -> 409", r.status === 409);
const a = t({ notes: "=SUM(A1)" });
r = await post("/api/trial", a); b = await j(r);
check("counted run 1 assigned by server", r.ok && b.run === 1, JSON.stringify(b));
const c2 = t({ run: 9 });
r = await post("/api/trial", c2); b = await j(r);
check("counted run 2 assigned by server", r.ok && b.run === 2);
r = await post("/api/trial", t({})); b = await j(r);
check("third counted run in a cell -> 409 cell_full", r.status === 409 && b.code === "cell_full");
r = await post("/api/trial", t({ status: "exploratory" }));
check("extra run saves as exploratory", r.ok);
r = await post("/api/trial", t({ status: "excluded", statusReason: "no" }));
check("excluded without a real reason -> 400", r.status === 400);

let rep = await j(await get("/api/report"));
const cell = rep.scenarios[0].standard;
check("report: 2 counted, tech failure and exploratory outside the denominator", cell.trials === 2 && cell.premature.judged === 2 && cell.technicalFailures === 1 && cell.exploratory === 1, JSON.stringify({ trials: cell.trials, p: cell.premature, tf: cell.technicalFailures }));
check("report: progress 2/24, decision insufficient", rep.progress.valid === 2 && rep.decision.verdict === "insufficient");

r = await post("/api/trial-status", { id: a.id, status: "excluded", statusReason: "speaker coughed mid-request" });
check("exclude a saved trial", r.ok);
rep = await j(await get("/api/report"));
check("after exclusion the planned run is open again", rep.progress.valid === 1 && rep.scenarios[0].standard.excluded === 1);
r = await post("/api/trial", t({})); b = await j(r);
check("freed slot can be refilled", r.ok && b.run === 2, JSON.stringify(b));

const csv = await (await get("/api/export")).text();
check("csv: header + 5 rows, formula neutralised", csv.trim().split("\n").length === 6 && csv.includes("'=SUM(A1)"), `rows=${csv.trim().split("\n").length}`);
const list = await j(await get("/api/trials"));
check("trials persist and list", list.trials.length === 5);

// --- delete needs the exact phrase, and archives
r = await fetch(`${B}/api/trials`, { method: "DELETE", headers: H, body: "{}" });
b = await j(r);
check("delete without confirmation -> 400", r.status === 400 && b.code === "confirm_required" && b.count === 5);
r = await fetch(`${B}/api/trials`, { method: "DELETE", headers: H, body: JSON.stringify({ confirm: "DELETE 4 TRIALS" }) });
check("delete with wrong count -> 400", r.status === 400);
r = await fetch(`${B}/api/trials`, { method: "DELETE", headers: H, body: JSON.stringify({ confirm: "DELETE 5 TRIALS" }) });
b = await j(r);
check("delete with exact phrase archives", r.ok && b.archived === 5);
check("store empty afterwards", (await j(await get("/api/trials"))).trials.length === 0);

// --- sign out
r = await fetch(`${B}/api/session`, { method: "DELETE", headers: H });
check("sign out clears the cookie", r.ok && /Max-Age=0/.test(r.headers.get("set-cookie") ?? ""));
r = await fetch(`${B}/`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
