/**
 * Browser test of the real UI against a LOCAL dev server, with Chrome's fake
 * microphone. Playwright is not a project dependency: install it anywhere and
 * point PLAYWRIGHT_DIR at the folder that contains its node_modules, e.g.
 *
 *   PLAYWRIGHT_DIR=$(npm root -g) node scripts/ui-local.mjs
 *
 * It saves and deletes trials, so it refuses to run against anything but localhost.
 */
import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
const require = createRequire(process.env.PLAYWRIGHT_DIR ? `${process.env.PLAYWRIGHT_DIR}/` : import.meta.url);
const { chromium } = require("playwright");
const B = process.env.PACELAB_URL ?? "http://localhost:5199";
const PASS = process.env.PACELAB_TEST_PASSPHRASE ?? "local-test-only";
if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(B)) {
  console.error(`Refusing to run against ${B}: this script deletes trials. Use a local dev server.`);
  process.exit(2);
}
const out = process.env.SHOTS_DIR ?? "test-results/ui";
mkdirSync(out, { recursive: true });
let pass = 0, fail = 0;
const check = (name, ok, extra = "") => { ok ? pass++ : fail++; console.log(`${ok ? "PASS" : "FAIL"}  ${name} ${extra}`); };

async function session(denyMic) {
  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--use-fake-device-for-media-stream", ...(denyMic ? [] : ["--use-fake-ui-for-media-stream"])]
  });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 }, permissions: denyMic ? [] : ["microphone"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  return { browser, page, errors };
}

// ---------- gate, demo, workbench, failed call ----------
{
  const { browser, page, errors } = await session(false);
  await page.goto(B);
  check("gate shows demo and sign-in", await page.getByText("Open the demo").isVisible() && await page.getByLabel("Passphrase").isVisible());
  await page.screenshot({ path: `${out}/01-gate.png` });

  await page.getByText("Open the demo").click();
  check("demo is labelled synthetic", await page.getByText("Demo with synthetic data.").isVisible());
  check("demo report shows a directional verdict", await page.getByText("Patient had fewer premature responses in these samples").isVisible());
  const reqs = [];
  page.on("request", (r) => { if (r.url().includes("/api/") || r.url().includes("/agents/")) reqs.push(r.url()); });
  await page.getByText("Play the example").click();
  await page.waitForTimeout(3500);
  check("demo replay shows the cut-off", await page.getByText("reply cut off").isVisible());
  await page.getByRole("button", { name: "Scenario 6" }).click();
  check("demo makes no API or agent requests", reqs.length === 0, reqs.join(","));
  await page.screenshot({ path: `${out}/02-demo.png`, fullPage: true });
  await page.getByText("Leave the demo").click();

  await page.getByLabel("Passphrase").fill(PASS);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByText(/Recommended next: scenario 1 in Standard mode, run 1/).waitFor();
  check("workbench: recommended next follows the plan", true);
  check("workbench: empty report explains itself", await page.getByText("No counted trials yet.").isVisible());
  check("workbench: 0/24 counted", await page.getByText("0/24").isVisible());
  check("script for scenario 1 shown", await page.getByText("Can I book a cleaning for Tuesday afternoon?").isVisible());
  await page.screenshot({ path: `${out}/03-workbench.png`, fullPage: true });

  // pick scenario 6 via the matrix: script shows pause markers
  await page.getByRole("combobox").selectOption("6");
  check("scenario 6 shows two pause markers", (await page.locator(".pause").count()) === 2);

  // rapid double click on Start: one call only
  const calls = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/call")) calls.push(r.url()); });
  const start = page.getByRole("button", { name: "Start call" });
  await start.dblclick();
  await page.getByText("The call failed").waitFor({ timeout: 20000 });
  check("double-click Start made exactly one reservation", calls.length === 1, `n=${calls.length}`);
  check("failed start shows a failure card, not the label form", !(await page.getByText("Label this call").isVisible()));
  check("failure card says no slot was used", await page.getByText("The call never started, so no call slot was used.", { exact: false }).isVisible());
  check("failure card shows the provider's words", await page.getByText("Provider response:", { exact: false }).isVisible());
  check("status line reads Failed", await page.locator(".status").innerText().then((t) => t.includes("Failed")));
  await page.screenshot({ path: `${out}/04-failed-call.png`, fullPage: true });
  await page.waitForTimeout(1200);
  check("calls left unchanged after failed start", await page.locator(".stats").innerText().then((t) => /30\s*\ncalls left today/.test(t)), (await page.locator(".stats").innerText()).replace(/\n/g, " | "));

  await page.getByRole("button", { name: "Record as technical failure" }).click();
  await page.getByText("Recorded as a technical failure.", { exact: false }).waitFor();
  check("technical failure recorded with confirmation", true);
  await page.reload();
  await page.getByText("Saved trials (1)").waitFor();
  check("saved trial survives a refresh", true);
  check("technical failure is outside the experiment counts", await page.getByText("0/24").isVisible());

  // start then cancel immediately, then start again: no stuck state
  await page.getByRole("button", { name: "Start call" }).click();
  await page.getByRole("button", { name: /Cancel|End call/ }).click().catch(() => {});
  await page.waitForTimeout(600);
  const st = await page.locator(".status").innerText();
  check("Start then Cancel returns to Ready or Failed (never stuck)", /Ready|Failed/.test(st), st);
  if (await page.getByRole("button", { name: "Dismiss" }).first().isVisible().catch(() => false)) await page.getByRole("button", { name: "Dismiss" }).first().click();
  await page.waitForTimeout(400);
  check("Start is enabled again", await page.getByRole("button", { name: "Start call" }).isEnabled());

  // delete needs the typed phrase
  const del = page.getByRole("button", { name: "Remove all trials" });
  check("delete button disabled until phrase typed", await del.isDisabled());
  await page.getByLabel(/to confirm/).fill("DELETE 1 TRIALS");
  check("delete button enabled with exact phrase", await del.isEnabled());
  await del.click();
  await page.getByText("1 trials removed", { exact: false }).waitFor();
  check("delete archived the trial", true);

  // mobile width
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check("no horizontal overflow at 390px", overflow <= 1, `overflow=${overflow}`);
  await page.screenshot({ path: `${out}/05-mobile.png`, fullPage: true });
  check("no page errors", errors.filter((e) => !/Failed to load resource|WebSocket|Mic error|VoiceClient/.test(e)).length === 0, errors.join(" || ").slice(0, 400));
  await browser.close();
}

// ---------- microphone denied ----------
{
  const { browser, page } = await session(true);
  await page.goto(B);
  await page.getByLabel("Passphrase").fill(PASS);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "Start call" }).waitFor();
  const calls = [];
  page.on("request", (r) => { if (r.url().endsWith("/api/call")) calls.push(1); });
  await page.getByRole("button", { name: "Start call" }).click();
  await page.getByText("The call failed").waitFor({ timeout: 15000 });
  const text = await page.locator(".failure").innerText();
  check("mic denied: clear message", /microphone/i.test(text), text.replace(/\n/g, " ").slice(0, 160));
  check("mic denied: no reservation was made", calls.length === 0);
  check("mic denied: not offered as a trial", !(await page.getByRole("button", { name: "Record as technical failure" }).isVisible()));
  await browser.close();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
