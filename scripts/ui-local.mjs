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

async function signIn(page) {
  await page.goto(`${B}/#/workbench`);
  await page.getByLabel("Passphrase").fill(PASS);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator(".bench").waitFor();
}

async function noOverflow(page, label) {
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  check(`no horizontal overflow at 390px: ${label}`, overflow <= 1, `overflow=${overflow}`);
}

// ---------- overview, navigation, demo ----------
{
  const { browser, page, errors } = await session(false);
  const reqs = [];
  page.on("request", (r) => { if (r.url().includes("/api/") || r.url().includes("/agents/")) reqs.push(r.url()); });
  await page.goto(B);
  check("overview hero headline", await page.getByRole("heading", { level: 1 }).innerText().then((t) => /when to listen/i.test(t)));
  const links = await page.locator("nav[aria-label=Main] .nav-link").allInnerTexts();
  check("nav: Overview | Workbench | Results | Demo", links.join("|") === "Overview|Workbench|Results|Demo", links.join("|"));
  check("nav marks the current page", (await page.locator('.nav-link[aria-current="page"]').innerText()) === "Overview");
  check("overview animation is labelled", await page.locator("figure.hero-viz").getAttribute("aria-label").then((t) => /Standard replies during the pause/.test(t ?? "")));
  check("overview sample is marked synthetic", await page.getByText("Synthetic sample").isVisible());
  await page.screenshot({ path: `${out}/01-overview.png` });

  await page.keyboard.press("Tab");
  check("first Tab reaches the skip link", (await page.evaluate(() => document.activeElement?.textContent)) === "Skip to content");

  await page.getByRole("button", { name: "Explore the demo" }).first().click();
  await page.waitForURL(/#\/demo$/);
  check("demo is labelled synthetic", await page.getByText("Demo with synthetic data.").isVisible());
  check("demo report shows a directional verdict", await page.getByText("Patient had fewer premature responses in these samples").isVisible());
  await page.getByText("12.5 s of 12.5 s", { exact: false }).waitFor({ timeout: 15000 });
  check("demo timeline plays to the end and shows the cut-off", await page.locator(".tl-log.standard").getByText("reply cut off").isVisible());
  check("demo shows the evaluation", await page.getByText("Premature: Yes").isVisible() && await page.getByText("Premature: No").isVisible());
  await page.getByText("Every measure").click();
  await page.getByRole("button", { name: "Scenario 6" }).click();
  check("demo per-scenario comparison opens", await page.locator("caption", { hasText: "Scenario 6: Multiple pauses" }).isVisible());
  check("demo offers a client-side CSV", await page.getByRole("button", { name: "Download demo CSV" }).isVisible());
  check("overview and demo make no API or agent requests", reqs.length === 0, reqs.join(","));
  await page.screenshot({ path: `${out}/02-demo.png`, fullPage: true });

  await page.setViewportSize({ width: 390, height: 800 });
  await noOverflow(page, "demo");
  await page.goto(`${B}/#/overview`);
  await noOverflow(page, "overview");
  await page.locator(".nav-toggle").click();
  check("mobile menu opens with all links", await page.locator(".nav-links.open .nav-link").count() === 4);
  check("no page errors on public pages", errors.length === 0, errors.join(" || ").slice(0, 400));
  await browser.close();
}

// ---------- reduced motion ----------
{
  const browser = await chromium.launch({ channel: "chrome" });
  const ctx = await browser.newContext({ viewport: { width: 1180, height: 900 }, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  await page.goto(B);
  const op = await page.locator(".hero-viz .ev-late").evaluate((e) => getComputedStyle(e).opacity);
  check("reduced motion: hero shows the final frame", op === "1", `opacity=${op}`);
  await page.goto(`${B}/#/demo`);
  check("reduced motion: demo timeline starts at the end", await page.getByText("12.5 s of 12.5 s", { exact: false }).isVisible());
  await browser.close();
}

// ---------- sign-in, workbench, failed call, results ----------
{
  const { browser, page, errors } = await session(false);
  await page.goto(`${B}/#/results`);
  check("results needs sign-in and offers the demo", await page.getByText("Open the demo").isVisible() && await page.getByLabel("Passphrase").isVisible());
  await signIn(page);
  await page.getByText(/Recommended next: scenario 1 in Standard mode, run 1/).waitFor();
  check("workbench: recommended next follows the plan", true);
  check("workbench: 0/24 counted", (await page.locator(".mini-stats dd").first().innerText()) === "0/24");
  check("script for scenario 1 shown", await page.locator(".config").getByText("Can I book a cleaning for Tuesday afternoon?").isVisible());
  check("mic is shown off before a call", await page.getByText("Off", { exact: true }).isVisible());
  await page.screenshot({ path: `${out}/03-workbench.png`, fullPage: true });

  await page.locator(".scenario", { hasText: "Multiple pauses" }).click();
  check("scenario 6 shows two pause markers", (await page.locator(".config .pause").count()) === 2);
  check("picking off-plan offers a way back", await page.getByRole("button", { name: "Back to the recommended trial" }).isVisible());

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
  check("phase reads Failed", await page.locator(".phase-pill").innerText().then((t) => t.includes("Failed")));
  await page.screenshot({ path: `${out}/04-failed-call.png`, fullPage: true });
  await page.waitForTimeout(1200);
  const stats = (await page.locator(".mini-stats").innerText()).replace(/\n/g, " ");
  check("calls left unchanged after failed start", /Calls left today 30\/30/.test(stats), stats);

  await page.getByRole("button", { name: "Record as technical failure" }).click();
  await page.getByText("Recorded as a technical failure.", { exact: false }).waitFor();
  check("technical failure recorded with confirmation", true);
  await page.reload();
  await page.locator(".bench").waitFor();
  check(
    "technical failure counted on the workbench",
    await page.waitForFunction(() => document.querySelectorAll(".mini-stats dd")[3]?.textContent === "1", null, { timeout: 8000 }).then(() => true, () => false)
  );

  // start then cancel immediately, then start again: no stuck state
  await page.getByRole("button", { name: "Start call" }).click();
  await page.getByRole("button", { name: /Cancel|End call/ }).click().catch(() => {});
  await page.waitForTimeout(600);
  const st = await page.locator(".phase-pill").innerText();
  check("Start then Cancel returns to Ready or Failed (never stuck)", /Ready|Failed/.test(st), st);
  if (await page.getByRole("button", { name: "Dismiss" }).first().isVisible().catch(() => false)) await page.getByRole("button", { name: "Dismiss" }).first().click();
  await page.waitForTimeout(400);
  check("Start is enabled again", await page.getByRole("button", { name: "Start call" }).isEnabled());

  await page.locator('.nav-link[href="#/results"]').click();
  await page.locator(".decision").waitFor();
  check("results: empty report explains itself", await page.getByText("No counted trials yet.").isVisible());
  check("results: honest insufficient evidence", await page.locator(".decision-head").innerText().then((t) => /Insufficient evidence/i.test(t)));
  check("results: saved trial survives a refresh", await page.getByRole("button", { name: "Technical failure 1" }).isVisible());
  check("results: 0 of 24 counted", await page.getByText("0 of 24 counted", { exact: false }).isVisible());
  check("results: CSV export points at the API", (await page.getByRole("link", { name: "Export CSV" }).getAttribute("href")) === "/api/export");
  await page.screenshot({ path: `${out}/05-results.png`, fullPage: true });

  // delete needs the typed phrase
  await page.locator("details.danger > summary").click();
  const del = page.locator("button.btn-danger");
  check("delete button disabled until phrase typed", await del.isDisabled());
  await page.getByLabel(/to confirm/).fill("DELETE 1 TRIALS");
  check("delete button enabled with exact phrase", await del.isEnabled());
  await del.click();
  await page.getByText("1 trials removed", { exact: false }).waitFor();
  check("delete archived the trial", true);

  await page.setViewportSize({ width: 390, height: 800 });
  await noOverflow(page, "results");
  await page.goto(`${B}/#/workbench`);
  await page.locator(".bench").waitFor();
  await noOverflow(page, "workbench");
  await page.screenshot({ path: `${out}/06-mobile-workbench.png`, fullPage: true });
  check("no page errors", errors.filter((e) => !/Failed to load resource|WebSocket|Mic error|VoiceClient/.test(e)).length === 0, errors.join(" || ").slice(0, 400));
  await browser.close();
}

// ---------- microphone denied ----------
{
  const { browser, page } = await session(true);
  await signIn(page);
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
