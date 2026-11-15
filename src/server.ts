import { Agent, getAgentByName, routeAgentRequest } from "agents";
import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from "agents/voice";
import type { Connection } from "agents";
import type { Transcriber, VoiceTurnContext } from "agents/voice";
import { createAI } from "agents/models/ai-sdk";
import { streamText } from "ai";
import {
  AGENT_FOR_MODE,
  AUTH_MAX_FAILURES,
  AUTH_WINDOW_MS,
  DAILY_CALL_CAP,
  EOT_THRESHOLD,
  EOT_TIMEOUT_MS,
  LLM_MODEL,
  MAX_CALL_MS,
  MODES,
  type Mode,
  NEURON_BUDGET_PER_DAY,
  SESSION_COOKIE,
  SYSTEM_PROMPT,
  TOKEN_TTL_MS,
  TTS_MODEL,
  TTS_SPEAKER
} from "./config";
import {
  checkPassphrase,
  clientHandle,
  mintToken,
  readCookie,
  sessionCookie,
  verifyToken
} from "./lib/auth";
import { nextRun } from "./lib/experiment";
import {
  classifyProviderResponse,
  type FailureCode,
  sanitizeProviderText
} from "./lib/failures";
import {
  type CallRow,
  type CallState,
  decideReservation,
  settleStale,
  summarizeUsage,
  utcDay
} from "./lib/quota";
import { buildReport } from "./lib/report";
import { type Trial, trialsToCsv, upgradeTrial, validateTrial } from "./lib/trial";

/** Call names are made by the browser: "trial-" plus a UUID. */
const CALL_NAME = /^trial-[0-9a-f-]{36}$/;

// Server diagnostics are not forwarded to the browser in production.
const VoiceAgent = withVoice(Agent);

/**
 * Shared base for both modes: prompt, LLM and voice.
 * Subclasses differ by exactly one value, the end-of-turn threshold.
 */
abstract class PaceVoiceAgent extends VoiceAgent<Env> {
  /** The one experimental variable. */
  protected abstract readonly eotThreshold: number;

  /** Force-end timer, so an abandoned call cannot run up Workers AI usage. */
  private callTimer?: ReturnType<typeof setTimeout>;
  /** Speech recognition came up, so this is a real call that used a slot. */
  private live = false;
  /** The call's final state has been sent to the store. */
  private settled = false;
  /** Why speech recognition would not start, when Workers AI said so. */
  private failure: FailureCode | null = null;
  /** Characters sent to text-to-speech, for the budget estimate. */
  private ttsChars = 0;

  tts = new WorkersAITTS(this.env.AI, {
    model: TTS_MODEL,
    speaker: TTS_SPEAKER
  });

  /**
   * Built per connection so the threshold comes from the subclass.
   * eotTimeoutMs is set explicitly: it caps every pause regardless of
   * confidence, so leaving it implicit would hide a ceiling on the experiment.
   *
   * The AI binding is wrapped for one reason. When Workers AI refuses a Flux
   * session it answers with an ordinary HTTP response instead of a WebSocket,
   * and the SDK reports only "Speech recognition failed to start". The wrapper
   * reads that response, so the log and the browser get the real cause.
   */
  createTranscriber(connection: Connection): Transcriber {
    const ai = this.env.AI as unknown as {
      run(model: string, input: unknown, options?: unknown): Promise<unknown>;
    };
    const observed = {
      run: async (
        model: string,
        input: Record<string, unknown>,
        options?: Record<string, unknown>
      ) => {
        try {
          const resp = await ai.run(model, input, options);
          if (!(resp as { webSocket?: unknown } | null)?.webSocket) {
            await this.noteProviderFailure(connection, resp);
          }
          return resp;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          this.recordFailure(connection, classifyProviderResponse(undefined, message), message);
          throw error;
        }
      }
    };
    return new WorkersAIFluxSTT(observed, {
      eotThreshold: this.eotThreshold,
      eotTimeoutMs: EOT_TIMEOUT_MS
    });
  }

  private async noteProviderFailure(connection: Connection, resp: unknown) {
    let status: number | undefined;
    let body = "";
    if (resp instanceof Response) {
      status = resp.status;
      body = await resp
        .clone()
        .text()
        .catch(() => "");
    }
    this.recordFailure(connection, classifyProviderResponse(status, body), `HTTP ${status ?? "?"} ${body}`);
  }

  private recordFailure(connection: Connection, code: FailureCode, raw: string) {
    this.failure = code;
    const detail = sanitizeProviderText(raw);
    console.error({ component: "PaceLab", stage: "stt_startup", code, detail });
    try {
      connection.send(JSON.stringify({ type: "pacelab_failure", code, detail }));
    } catch {
      // The browser has gone; the store still gets the code.
    }
  }

  /** Tell the store what became of this call. Never lets a store error break the call. */
  private async settle(event: "established" | "ended" | "failed", failCode = "") {
    try {
      const target = await getAgentByName(this.env.TrialStore, "pacelab");
      await target.fetch(
        new Request("https://pacelab.internal/api/call-event", {
          method: "POST",
          body: JSON.stringify({ name: this.name, event, ttsChars: this.ttsChars, failCode })
        })
      );
    } catch (error) {
      console.error({ component: "PaceLab", stage: "call_accounting", error: String(error) });
    }
  }

  beforeSynthesize(text: string) {
    this.ttsChars += text.length;
    return text;
  }

  async onCallStart(connection: Connection) {
    this.live = true;
    clearTimeout(this.callTimer);
    this.callTimer = setTimeout(() => {
      this.forceEndCall(connection);
    }, MAX_CALL_MS);
    await this.settle("established");
  }

  async onCallEnd() {
    clearTimeout(this.callTimer);
    this.callTimer = undefined;
    if (this.settled) return;
    this.settled = true;
    // A call that never came up gives its slot back.
    if (this.live) await this.settle("ended");
    else await this.settle("failed", this.failure ?? "stt_startup_failed");
  }

  /** The socket closed without the call ending first: tab closed, network gone, or cancelled. */
  async onClose() {
    clearTimeout(this.callTimer);
    if (this.settled) return;
    this.settled = true;
    if (this.live) await this.settle("ended");
    else await this.settle("failed", this.failure ?? "cancelled");
  }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const ai = createAI({ binding: this.env.AI });
    const result = streamText({
      // Gemma 4 reasons silently before its first word by default: 5-21 s in
      // live tests, long enough for any new speech to barge in and abort the
      // reply. A spoken scheduling answer needs no reasoning, so turn it off.
      model: ai(LLM_MODEL, {
        sessionAffinity: this.sessionAffinity,
        reasoningEffort: null
      }),
      system: SYSTEM_PROMPT,
      messages: [
        ...context.messages.map((m) => ({
          role:
            m.role === "assistant" ? ("assistant" as const) : ("user" as const),
          content: m.content
        })),
        { role: "user" as const, content: transcript }
      ],
      abortSignal: context.signal
    });
    return result.textStream;
  }
}

/** Favors fast responses. */
export class StandardVoiceAgent extends PaceVoiceAgent {
  protected readonly eotThreshold = EOT_THRESHOLD.standard;
}

/** Waits for more confidence before ending a turn. */
export class PatientVoiceAgent extends PaceVoiceAgent {
  protected readonly eotThreshold = EOT_THRESHOLD.patient;
}

interface CallSqlRow {
  name: string;
  day: string;
  mode: string;
  state: string;
  reserved_at: number;
  started_at: number | null;
  ended_at: number | null;
  tts_chars: number;
  fail_code: string;
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * One instance holds every trial from both modes, so export reads from one
 * place. It also holds what bounds spend and brute force: one row per call,
 * and failed passphrase attempts per client.
 */
export class TrialStore extends Agent<Env> {
  onStart() {
    this.sql`
      CREATE TABLE IF NOT EXISTS trials (
        id TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL,
        mode TEXT NOT NULL,
        scenario INTEGER NOT NULL,
        run INTEGER NOT NULL,
        payload TEXT NOT NULL
      )
    `;
    // Deleted trials are moved here, not destroyed.
    this.sql`
      CREATE TABLE IF NOT EXISTS trials_archive (
        id TEXT NOT NULL,
        deleted_at INTEGER NOT NULL,
        payload TEXT NOT NULL
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS calls (
        name TEXT PRIMARY KEY,
        day TEXT NOT NULL,
        mode TEXT NOT NULL,
        state TEXT NOT NULL,
        reserved_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        tts_chars INTEGER NOT NULL DEFAULT 0,
        fail_code TEXT NOT NULL DEFAULT ''
      )
    `;
    this.sql`
      CREATE TABLE IF NOT EXISTS auth_failures (
        handle TEXT NOT NULL,
        at INTEGER NOT NULL
      )
    `;
  }

  private all(): Trial[] {
    const rows = this.sql<{ payload: string }>`
      SELECT payload FROM trials ORDER BY created_at ASC
    `;
    return rows.map((r) => upgradeTrial(JSON.parse(r.payload)));
  }

  private saveTrial(trial: Trial) {
    this.sql`
      INSERT OR REPLACE INTO trials (id, created_at, mode, scenario, run, payload)
      VALUES (
        ${trial.id}, ${trial.createdAt}, ${trial.mode},
        ${trial.scenario}, ${trial.run}, ${JSON.stringify(trial)}
      )
    `;
  }

  private writeCall(r: CallRow) {
    this.sql`
      INSERT OR REPLACE INTO calls
        (name, day, mode, state, reserved_at, started_at, ended_at, tts_chars, fail_code)
      VALUES (
        ${r.name}, ${r.day}, ${r.mode}, ${r.state}, ${r.reservedAt},
        ${r.startedAt}, ${r.endedAt}, ${r.ttsChars}, ${r.failCode}
      )
    `;
  }

  /** Today's calls, with any that stopped reporting settled by the clock. */
  private callsToday(now: number): CallRow[] {
    const rows = this.sql<CallSqlRow>`SELECT * FROM calls WHERE day = ${utcDay(now)}`.map(
      (r): CallRow => ({
        name: r.name,
        day: r.day,
        mode: r.mode,
        state: r.state as CallState,
        reservedAt: r.reserved_at,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        ttsChars: r.tts_chars,
        failCode: r.fail_code
      })
    );
    const changed = settleStale(rows, now);
    for (const c of changed) this.writeCall(c);
    return rows.map((r) => changed.find((c) => c.name === r.name) ?? r);
  }

  /** Reserve a slot before any WebSocket is accepted. */
  private reserve(name: string, mode: string): Response {
    const now = Date.now();
    const rows = this.callsToday(now);
    const decision = decideReservation(rows, name, mode);
    if (!decision.allowed) {
      return json({ error: decision.message, code: decision.code }, decision.status);
    }
    if (!decision.reuse) {
      const row: CallRow = {
        name,
        day: utcDay(now),
        mode,
        state: "reserved",
        reservedAt: now,
        startedAt: null,
        endedAt: null,
        ttsChars: 0,
        failCode: ""
      };
      this.writeCall(row);
      rows.push(row);
    }
    return json({ ok: true, usage: summarizeUsage(rows, now) });
  }

  /** The WebSocket for a call is accepted only while its reservation is open. */
  private check(name: string, mode: string): Response {
    const row = this.callsToday(Date.now()).find((r) => r.name === name);
    const ok = !!row && row.mode === mode && (row.state === "reserved" || row.state === "established");
    return json({ ok });
  }

  /** The voice agent reports what became of the call. */
  private callEvent(body: { name?: string; event?: string; ttsChars?: number; failCode?: string }) {
    const now = Date.now();
    const row = this.callsToday(now).find((r) => r.name === body.name);
    if (!row) return json({ ok: false });
    if (body.event === "established" && row.state === "reserved") {
      this.writeCall({ ...row, state: "established", startedAt: now });
    } else if (body.event === "ended" && row.state === "established") {
      this.writeCall({ ...row, state: "ended", endedAt: now, ttsChars: Number(body.ttsChars) || 0 });
    } else if (body.event === "failed" && row.state === "reserved") {
      // Only a call that never came up can give its slot back.
      this.writeCall({
        ...row,
        state: "failed",
        endedAt: now,
        failCode: String(body.failCode || "stt_startup_failed").slice(0, 60)
      });
    }
    return json({ ok: true });
  }

  /** How many failed passphrase attempts this client has made in the window. */
  private authFailures(handle: string): { failures: number; locked: boolean } {
    const since = Date.now() - AUTH_WINDOW_MS;
    this.sql`DELETE FROM auth_failures WHERE at < ${since}`;
    const rows = this.sql<{ n: number }>`
      SELECT COUNT(*) AS n FROM auth_failures WHERE handle = ${handle} AND at >= ${since}
    `;
    const failures = Number(rows[0]?.n ?? 0);
    return { failures, locked: failures >= AUTH_MAX_FAILURES };
  }

  private recordAuthFailure(handle: string): { failures: number; locked: boolean } {
    this.sql`INSERT INTO auth_failures (handle, at) VALUES (${handle}, ${Date.now()})`;
    return this.authFailures(handle);
  }

  private clearAuthFailures(handle: string) {
    this.sql`DELETE FROM auth_failures WHERE handle = ${handle}`;
  }

  /** Save a new trial. One call can be saved once; the store assigns the run number. */
  private addTrial(input: unknown): Response {
    const parsed = validateTrial(input);
    if (typeof parsed === "string") return json({ error: parsed }, 400);
    const all = this.all();
    if (all.some((t) => t.id === parsed.id)) {
      return json({ error: "This call has already been saved.", code: "duplicate" }, 409);
    }
    if (parsed.status === "counted") {
      const run = nextRun(all, parsed.scenario, parsed.mode);
      if (run === null) {
        return json(
          {
            error:
              "This scenario and mode already have both planned runs. Save this one as exploratory, or exclude an earlier run first.",
            code: "cell_full"
          },
          409
        );
      }
      parsed.run = run;
    }
    this.saveTrial(parsed);
    return json({ ok: true, id: parsed.id, run: parsed.run });
  }

  /** Change a saved trial's status, e.g. exclude it with a reason. Nothing else is editable. */
  private setStatus(body: { id?: string; status?: string; statusReason?: string }): Response {
    const all = this.all();
    const current = all.find((t) => t.id === body.id);
    if (!current) return json({ error: "No such trial." }, 404);
    const parsed = validateTrial({
      ...current,
      status: body.status,
      statusReason: body.statusReason ?? ""
    });
    if (typeof parsed === "string") return json({ error: parsed }, 400);
    if (parsed.status === "counted") {
      const run = nextRun(
        all.filter((t) => t.id !== current.id),
        parsed.scenario,
        parsed.mode
      );
      if (run === null) {
        return json({ error: "This scenario and mode already have both planned runs.", code: "cell_full" }, 409);
      }
      parsed.run = run;
    }
    parsed.createdAt = current.createdAt;
    this.saveTrial(parsed);
    return json({ ok: true, id: parsed.id, run: parsed.run });
  }

  /**
   * Remove every trial. The caller must type the exact count back, and the
   * rows are moved to an archive table rather than destroyed.
   */
  private deleteAll(body: { confirm?: string }): Response {
    const n = Number(this.sql<{ n: number }>`SELECT COUNT(*) AS n FROM trials`[0]?.n ?? 0);
    const expected = `DELETE ${n} TRIALS`;
    if (body.confirm !== expected) {
      return json(
        { error: `To delete all ${n} trials, send confirm: "${expected}".`, code: "confirm_required", count: n },
        400
      );
    }
    const now = Date.now();
    this.sql`INSERT INTO trials_archive (id, deleted_at, payload) SELECT id, ${now}, payload FROM trials`;
    this.sql`DELETE FROM trials`;
    return json({ ok: true, archived: n });
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split("/").pop() ?? "";
    const handle = url.searchParams.get("handle") ?? "";
    const method = request.method;
    const body = async () =>
      (await request.json().catch(() => ({}))) as Record<string, string | undefined>;

    if (method === "POST") {
      switch (action) {
        case "auth-check":
          return json(this.authFailures(handle));
        case "auth-failed":
          return json(this.recordAuthFailure(handle));
        case "auth-ok":
          this.clearAuthFailures(handle);
          return json({ ok: true });
        case "call-reserve": {
          const b = await body();
          return this.reserve(String(b.name), String(b.mode));
        }
        case "call-check": {
          const b = await body();
          return this.check(String(b.name), String(b.mode));
        }
        case "call-event":
          return this.callEvent(await body());
        case "call-cancel": {
          const b = await body();
          return this.callEvent({ name: b.name, event: "failed", failCode: "cancelled" });
        }
        case "trial":
          return this.addTrial(await request.json().catch(() => null));
        case "trial-status":
          return this.setStatus(await body());
      }
    }

    if (method === "GET") {
      switch (action) {
        case "usage":
          return json(summarizeUsage(this.callsToday(Date.now()), Date.now()));
        case "trials":
          return json({ trials: this.all() });
        case "report":
          return json(buildReport(this.all()));
        case "export":
          return new Response(trialsToCsv(this.all()), {
            headers: {
              "content-type": "text/csv; charset=utf-8",
              "content-disposition": 'attachment; filename="pacelab-trials.csv"',
              "cache-control": "no-store"
            }
          });
      }
    }

    if (method === "DELETE" && action === "trials") {
      return this.deleteAll(await body());
    }

    return new Response("Not found", { status: 404 });
  }
}

function store(env: Env) {
  return getAgentByName(env.TrialStore, "pacelab");
}

/** Internal call into the single TrialStore instance. */
async function storeCall(env: Env, path: string, body?: unknown): Promise<Response> {
  const target = await store(env);
  return target.fetch(
    new Request(`https://pacelab.internal${path}`, {
      method: "POST",
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
  );
}

function assets(env: Env, request: Request): Promise<Response> {
  return (
    env.ASSETS?.fetch(request) ??
    Promise.resolve(new Response("Not found", { status: 404 }))
  );
}

/** Routes a signed-in browser may call, by method. Everything else under /api is internal. */
const PUBLIC_API: Record<string, string[]> = {
  GET: ["usage", "trials", "export", "report"],
  POST: ["trial", "trial-status", "call-cancel"],
  DELETE: ["trials"]
};

const MODE_FOR_AGENT = Object.fromEntries(
  MODES.map((mode) => [AGENT_FOR_MODE[mode], mode])
) as Record<string, Mode>;

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const passphrase = env.PACELAB_PASSPHRASE;
    const signingKey = env.PACELAB_TOKEN_SECRET;
    const isApi = url.pathname.startsWith("/api/");
    const isAgent = url.pathname.startsWith("/agents/");

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        app: "pacelab",
        gated: Boolean(passphrase && signingKey),
        modes: MODES.map((mode) => ({ mode, eotThreshold: EOT_THRESHOLD[mode] })),
        eotTimeoutMs: EOT_TIMEOUT_MS,
        maxCallMs: MAX_CALL_MS,
        dailyCallCap: DAILY_CALL_CAP,
        neuronBudgetPerDay: NEURON_BUDGET_PER_DAY,
        models: { llm: LLM_MODEL, tts: TTS_MODEL }
      });
    }

    // Fail closed: without both secrets nothing that can spend Workers AI runs.
    if (!passphrase || !signingKey) {
      if (isApi || isAgent) {
        return json({ error: "Worker is missing PACELAB_PASSPHRASE or PACELAB_TOKEN_SECRET." }, 503);
      }
      return assets(env, request);
    }

    if (!isApi && !isAgent) return assets(env, request);

    // A browser sends Origin on WebSocket upgrades and on every request that
    // changes something. One from another site is refused, whatever cookie it carries.
    const origin = request.headers.get("origin");
    const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
    if ((origin !== null && origin !== url.origin) || (upgrade && origin === null)) {
      return json({ error: "Cross-site request refused." }, 403);
    }

    if (url.pathname === "/api/session" && request.method === "POST") {
      const handle = await clientHandle(request, signingKey);
      const before = (await (
        await storeCall(env, `/api/auth-check?handle=${handle}`)
      ).json()) as { locked: boolean };
      if (before.locked) {
        return Response.json(
          { error: "Too many attempts. Try again in 15 minutes." },
          { status: 429, headers: { "retry-after": "900" } }
        );
      }

      const body = (await request.json().catch(() => ({}))) as { passphrase?: string };
      const ok = await checkPassphrase(body.passphrase ?? "", passphrase, signingKey);
      if (!ok) {
        const after = (await (
          await storeCall(env, `/api/auth-failed?handle=${handle}`)
        ).json()) as { failures: number; locked: boolean };
        return json(
          {
            error: after.locked
              ? "Too many attempts. Try again in 15 minutes."
              : `Wrong passphrase. ${AUTH_MAX_FAILURES - after.failures} attempts left.`
          },
          after.locked ? 429 : 401
        );
      }

      await storeCall(env, `/api/auth-ok?handle=${handle}`);
      const token = await mintToken(signingKey, TOKEN_TTL_MS);
      return Response.json(
        { ok: true, expiresInMs: TOKEN_TTL_MS },
        {
          headers: {
            "set-cookie": sessionCookie(SESSION_COOKIE, token, TOKEN_TTL_MS, url.protocol === "https:")
          }
        }
      );
    }

    if (url.pathname === "/api/session" && request.method === "DELETE") {
      return Response.json(
        { ok: true },
        { headers: { "set-cookie": sessionCookie(SESSION_COOKIE, "", 0, url.protocol === "https:") } }
      );
    }

    // Everything below needs a valid session. The token arrives in an HttpOnly
    // cookie, never a query string, so it stays out of request logs.
    const auth = await verifyToken(readCookie(request, SESSION_COOKIE), signingKey);
    if (!auth.ok) {
      return json({ error: "Your session has expired.", code: "session_expired" }, 401);
    }

    // Starting a call is two steps. First an ordinary request reserves a slot
    // and gets a precise answer if it cannot. Then the WebSocket for that call
    // is accepted only while the reservation is open. Both happen before the
    // voice pipeline is touched.
    if (url.pathname === "/api/call" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { name?: string; mode?: string };
      if (!CALL_NAME.test(body.name ?? "") || !MODES.includes(body.mode as Mode)) {
        return json({ error: "Bad call request." }, 400);
      }
      return storeCall(env, "/api/call-reserve", { name: body.name, mode: body.mode });
    }

    if (isAgent) {
      const [, , agent, name] = url.pathname.split("/");
      const mode = MODE_FOR_AGENT[agent ?? ""];
      if (!upgrade || !mode || !CALL_NAME.test(name ?? "")) {
        return json({ error: "Not found" }, 404);
      }
      const check = (await (
        await storeCall(env, "/api/call-check", { name, mode })
      ).json()) as { ok: boolean };
      if (!check.ok) {
        return json({ error: "No open reservation for this call.", code: "call_finished" }, 403);
      }
      return (await routeAgentRequest(request, env)) ?? json({ error: "Not found" }, 404);
    }

    const action = url.pathname.split("/").pop() ?? "";
    if (!PUBLIC_API[request.method]?.includes(action)) {
      return json({ error: "Not found" }, 404);
    }
    return (await store(env)).fetch(request);
  }
} satisfies ExportedHandler<Env>;
