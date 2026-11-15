import { Agent, getAgentByName, routeAgentRequest } from "agents";
import { withVoice, WorkersAIFluxSTT, WorkersAITTS } from "agents/voice";
import type { Connection } from "agents";
import type { Transcriber, VoiceTurnContext } from "agents/voice";
import { createAI } from "agents/models/ai-sdk";
import { streamText } from "ai";
import {
  AUTH_MAX_FAILURES,
  AUTH_WINDOW_MS,
  DAILY_CALL_CAP,
  EOT_THRESHOLD,
  EOT_TIMEOUT_MS,
  LLM_MODEL,
  MAX_CALL_MS,
  MODES,
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
import { type Trial, trialsToCsv } from "./lib/trial";

// Diagnostics forward the server's pipeline events (speech.started, stt.interim,
// stt.utterance, model.*, tts.*) to the browser console. On while the voice
// pipeline is being brought up; the app is gated, so only signed-in sessions see them.
const VoiceAgent = withVoice(Agent, { diagnostics: { browserConsole: true } });

/**
 * Shared base for both modes: prompt, LLM and voice.
 * Subclasses differ by exactly one value, the end-of-turn threshold.
 */
abstract class PaceVoiceAgent extends VoiceAgent<Env> {
  /** The one experimental variable. */
  protected abstract readonly eotThreshold: number;

  /** Force-end timer, so an abandoned call cannot run up Workers AI usage. */
  private callTimer?: ReturnType<typeof setTimeout>;

  tts = new WorkersAITTS(this.env.AI, {
    model: TTS_MODEL,
    speaker: TTS_SPEAKER
  });

  /**
   * Built per connection so the threshold comes from the subclass.
   * eotTimeoutMs is set explicitly: it caps every pause regardless of
   * confidence, so leaving it implicit would hide a ceiling on the experiment.
   */
  createTranscriber(): Transcriber {
    return new WorkersAIFluxSTT(this.env.AI, {
      eotThreshold: this.eotThreshold,
      eotTimeoutMs: EOT_TIMEOUT_MS
    });
  }

  onCallStart(connection: Connection) {
    clearTimeout(this.callTimer);
    this.callTimer = setTimeout(() => {
      this.forceEndCall(connection);
    }, MAX_CALL_MS);
  }

  onCallEnd() {
    clearTimeout(this.callTimer);
    this.callTimer = undefined;
  }

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const ai = createAI({ binding: this.env.AI });
    const result = streamText({
      model: ai(LLM_MODEL, { sessionAffinity: this.sessionAffinity }),
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

/**
 * One instance holds every trial from both modes, so export reads from one
 * place. It also holds the two counters that bound spend and brute force:
 * calls per UTC day, and failed passphrase attempts per client.
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
    this.sql`
      CREATE TABLE IF NOT EXISTS call_counts (
        day TEXT PRIMARY KEY,
        count INTEGER NOT NULL
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
    return rows.map((r) => JSON.parse(r.payload) as Trial);
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private usage(): { day: string; used: number; cap: number } {
    const rows = this.sql<{ count: number }>`
      SELECT count FROM call_counts WHERE day = ${this.today()}
    `;
    return { day: this.today(), used: rows[0]?.count ?? 0, cap: DAILY_CALL_CAP };
  }

  /** Reserve one call against today's cap. Returns false when the cap is reached. */
  private reserveCall(): { allowed: boolean; used: number; cap: number } {
    const { used } = this.usage();
    if (used >= DAILY_CALL_CAP) {
      return { allowed: false, used, cap: DAILY_CALL_CAP };
    }
    this.sql`
      INSERT INTO call_counts (day, count) VALUES (${this.today()}, 1)
      ON CONFLICT(day) DO UPDATE SET count = count + 1
    `;
    return { allowed: true, used: used + 1, cap: DAILY_CALL_CAP };
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

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const action = url.pathname.split("/").pop() ?? "";
    const handle = url.searchParams.get("handle") ?? "";

    if (request.method === "POST" && action === "auth-check") {
      return Response.json(this.authFailures(handle));
    }
    if (request.method === "POST" && action === "auth-failed") {
      return Response.json(this.recordAuthFailure(handle));
    }
    if (request.method === "POST" && action === "auth-ok") {
      this.clearAuthFailures(handle);
      return Response.json({ ok: true });
    }

    if (request.method === "POST" && action === "reserve-call") {
      return Response.json(this.reserveCall());
    }

    if (request.method === "GET" && action === "usage") {
      return Response.json(this.usage());
    }

    if (request.method === "POST" && action === "trial") {
      const trial = (await request.json()) as Trial;
      this.sql`
        INSERT OR REPLACE INTO trials (id, created_at, mode, scenario, run, payload)
        VALUES (
          ${trial.id}, ${trial.createdAt}, ${trial.mode},
          ${trial.scenario}, ${trial.run}, ${JSON.stringify(trial)}
        )
      `;
      return Response.json({ ok: true, id: trial.id });
    }

    if (request.method === "GET" && action === "trials") {
      return Response.json({ trials: this.all() });
    }

    if (request.method === "DELETE" && action === "trials") {
      this.sql`DELETE FROM trials`;
      return Response.json({ ok: true });
    }

    if (request.method === "GET" && action === "export") {
      return new Response(trialsToCsv(this.all()), {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": 'attachment; filename="pacelab-trials.csv"'
        }
      });
    }

    return new Response("Not found", { status: 404 });
  }
}

function store(env: Env) {
  return getAgentByName(env.TrialStore, "pacelab");
}

/** Internal call into the single TrialStore instance. */
async function storeCall<T>(
  env: Env,
  origin: string,
  path: string,
  method: "GET" | "POST"
): Promise<T> {
  const target = await store(env);
  const res = await target.fetch(new Request(`${origin}${path}`, { method }));
  return (await res.json()) as T;
}

function assets(env: Env, request: Request): Promise<Response> {
  return (
    env.ASSETS?.fetch(request) ??
    Promise.resolve(new Response("Not found", { status: 404 }))
  );
}

export default {
  async fetch(request: Request, env: Env) {
    const url = new URL(request.url);
    const passphrase = env.PACELAB_PASSPHRASE;
    const signingKey = env.PACELAB_TOKEN_SECRET;
    const isApi = url.pathname.startsWith("/api/");
    const isAgent = url.pathname.startsWith("/agents/");

    if (url.pathname === "/api/health") {
      return Response.json({
        ok: true,
        app: "pacelab",
        gated: Boolean(passphrase && signingKey),
        modes: MODES.map((mode) => ({ mode, eotThreshold: EOT_THRESHOLD[mode] })),
        eotTimeoutMs: EOT_TIMEOUT_MS,
        maxCallMs: MAX_CALL_MS,
        dailyCallCap: DAILY_CALL_CAP,
        models: { llm: LLM_MODEL, tts: TTS_MODEL }
      });
    }

    // Fail closed: without both secrets nothing that can spend Workers AI runs.
    if (!passphrase || !signingKey) {
      if (isApi || isAgent) {
        return Response.json(
          {
            error:
              "Worker is missing PACELAB_PASSPHRASE or PACELAB_TOKEN_SECRET."
          },
          { status: 503 }
        );
      }
      return assets(env, request);
    }

    if (url.pathname === "/api/session" && request.method === "POST") {
      const handle = await clientHandle(request, signingKey);
      const before = await storeCall<{ failures: number; locked: boolean }>(
        env,
        url.origin,
        `/api/auth-check?handle=${handle}`,
        "POST"
      );
      if (before.locked) {
        return Response.json(
          { error: "Too many attempts. Try again in 15 minutes." },
          { status: 429, headers: { "retry-after": "900" } }
        );
      }

      const body = (await request.json().catch(() => ({}))) as {
        passphrase?: string;
      };
      const ok = await checkPassphrase(
        body.passphrase ?? "",
        passphrase,
        signingKey
      );
      if (!ok) {
        const after = await storeCall<{ failures: number; locked: boolean }>(
          env,
          url.origin,
          `/api/auth-failed?handle=${handle}`,
          "POST"
        );
        return Response.json(
          {
            error: after.locked
              ? "Too many attempts. Try again in 15 minutes."
              : `Wrong passphrase. ${AUTH_MAX_FAILURES - after.failures} attempts left.`
          },
          { status: after.locked ? 429 : 401 }
        );
      }

      await storeCall(env, url.origin, `/api/auth-ok?handle=${handle}`, "POST");
      const token = await mintToken(signingKey, TOKEN_TTL_MS);
      return Response.json(
        { ok: true, expiresInMs: TOKEN_TTL_MS },
        {
          headers: {
            "set-cookie": sessionCookie(
              SESSION_COOKIE,
              token,
              TOKEN_TTL_MS,
              url.protocol === "https:"
            )
          }
        }
      );
    }

    // Everything below needs a valid session. The token arrives in an HttpOnly
    // cookie, never a query string, so it stays out of request logs.
    if (isApi || isAgent) {
      const auth = await verifyToken(
        readCookie(request, SESSION_COOKIE),
        signingKey
      );
      if (!auth.ok) {
        return Response.json({ error: auth.reason }, { status: 401 });
      }
    }

    // Reserve a slot against the daily cap before the WebSocket is accepted,
    // so an over-cap call never reaches the voice pipeline.
    if (isAgent) {
      const reservation = await storeCall<{
        allowed: boolean;
        used: number;
        cap: number;
      }>(env, url.origin, "/api/reserve-call", "POST");
      if (!reservation.allowed) {
        return Response.json(
          {
            error: `Daily call cap reached (${reservation.used}/${reservation.cap}). Resets at UTC midnight.`
          },
          { status: 429 }
        );
      }
      return (
        (await routeAgentRequest(request, env)) ??
        new Response("Not found", { status: 404 })
      );
    }

    // Only the trial-data routes are public. The counter routes the Worker
    // itself calls (auth-*, reserve-call) are never reachable from outside.
    if (isApi) {
      const action = url.pathname.split("/").pop() ?? "";
      const allowed =
        (request.method === "GET" &&
          ["usage", "trials", "export"].includes(action)) ||
        (request.method === "POST" && action === "trial") ||
        (request.method === "DELETE" && action === "trials");
      if (!allowed) {
        return Response.json({ error: "Not found" }, { status: 404 });
      }
      return (await store(env)).fetch(request);
    }

    return assets(env, request);
  }
} satisfies ExportedHandler<Env>;
