/**
 * The trial record. One row per call.
 *
 * Three kinds of evidence live here and are never mixed:
 *   [SDK] measured by the Agents SDK on the server clock
 *   [M]   judged by the person running the trial
 *   [~]   estimated in the browser (mic level, browser clock)
 *
 * A committed-turn split is an SDK fact. Whether the agent replied too early
 * is a human judgment. The record keeps both and derives neither from the other.
 */

export type Mode = "standard" | "patient";

/** A manual judgment. "unknown" means the person could not tell. */
export type Judgment = "yes" | "no" | "unknown";

/**
 * counted           part of the planned 24-trial matrix
 * exploratory       kept, never counted
 * excluded          a conversational trial thrown out, with a reason
 * technical_failure the call failed before or during the test; not a conversation
 */
export type TrialStatus = "counted" | "exploratory" | "excluded" | "technical_failure";

export const TRIAL_STATUSES: TrialStatus[] = [
  "counted",
  "exploratory",
  "excluded",
  "technical_failure"
];

export interface TrialLabels {
  /** The agent replied before the request was finished. */
  premature: Judgment;
  /** The transcript captured the key intent and details. Exact wording not required. */
  transcriptionCorrect: Judgment;
  /** The reply fits the whole request, not a fragment of it. */
  responseAppropriate: Judgment;
  /** The spoken reply was cancelled or cut short. */
  replyCutShort: Judgment;
}

/** [SDK] timings for the first speech turn the agent answered. Absent when not reached. */
export interface TrialTimings {
  /** Flux speech start to final transcript. Includes speaking time and pauses. Not latency. */
  speechStartToFinalMs?: number;
  afterTranscribeMs?: number;
  /** Model call to its first text. */
  modelToFirstTextMs?: number;
  /** First TTS call to first audio sent. */
  ttsToFirstAudioMs?: number;
  /** Final transcript to first audio leaving the server. */
  finalInputToFirstAudioMs?: number;
  turnTotalMs?: number;
  /** The SDK's terminal outcome for that turn, e.g. "completed" or "interrupted". */
  outcome?: string;
}

/** [~] browser-side estimates. */
export interface PerceivedTiming {
  /** Last mic level above the voice threshold to first agent audio. */
  approxSpeechEndToFirstAudioMs?: number;
  /** Lengths of the pauses the speaker actually held, from the mic level. */
  approxPausesMs?: number[];
}

/** One client-observed event, in milliseconds since the call was ready. */
export interface TrialEvent {
  t: number;
  type: string;
  detail?: string;
}

export interface Trial {
  schema: 2;
  /** Equals the call's instance name, so one call can only be saved once. */
  id: string;
  createdAt: number;
  mode: Mode;
  scenario: number;
  /** 1 or 2 for counted trials (assigned by the server), 0 otherwise. */
  run: number;
  eotThreshold: number;
  status: TrialStatus;
  /** Why it was excluded, or what failed. Required for excluded and technical_failure. */
  statusReason: string;
  /** Machine code for a technical failure, e.g. "provider_quota". */
  failureCode: string;
  /** [SDK] committed user transcripts before the first reply, in order. */
  userTranscripts: string[];
  /** [SDK] the agent's first reply text. */
  agentReply: string;
  /** [SDK] committed user turns before the first reply. More than 1 is a split, not a verdict. */
  turnCount: number;
  /** [~] times the person pressed "Cut me off" during the call. An observation, not a classification. */
  cutOffPresses: number;
  labels: TrialLabels;
  timings: TrialTimings;
  perceived: PerceivedTiming;
  events: TrialEvent[];
  /** A typed correction was sent during the call. */
  repaired: boolean;
  notes: string;
}

export const UNKNOWN_LABELS: TrialLabels = {
  premature: "unknown",
  transcriptionCorrect: "unknown",
  responseAppropriate: "unknown",
  replyCutShort: "unknown"
};

/** True when the call produced something a person can judge. */
export function hasConversation(t: Pick<Trial, "userTranscripts">): boolean {
  return t.userTranscripts.some((s) => s.trim().length > 0);
}

/** [SDK] the request was committed as more than one turn. */
export function isSplit(t: Pick<Trial, "turnCount">): boolean {
  return t.turnCount > 1;
}

/**
 * The primary outcome, or null when any of its three labels is unknown.
 * Successful: not premature, transcription correct, reply appropriate, no typed repair.
 */
export function turnSucceeded(t: Trial): boolean | null {
  const l = t.labels;
  if ([l.premature, l.transcriptionCorrect, l.responseAppropriate].includes("unknown")) {
    return null;
  }
  return (
    l.premature === "no" &&
    l.transcriptionCorrect === "yes" &&
    l.responseAppropriate === "yes" &&
    !t.repaired
  );
}

// --- Validation ---------------------------------------------------------------

const JUDGMENTS: Judgment[] = ["yes", "no", "unknown"];
/** Too short to explain anything. */
const MIN_REASON = 8;

function judgment(v: unknown): Judgment | null {
  return JUDGMENTS.includes(v as Judgment) ? (v as Judgment) : null;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : undefined;
}

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

/**
 * Check and normalise a trial before it reaches storage. Returns the clean
 * trial, or a sentence saying what is wrong. `run` is set by the store.
 */
export function validateTrial(input: unknown): Trial | string {
  if (!input || typeof input !== "object") return "The trial must be an object.";
  if (JSON.stringify(input).length > 30_000) return "The trial is too large.";
  const t = input as Record<string, unknown>;

  if (typeof t.id !== "string" || !/^trial-[0-9a-f-]{36}$/.test(t.id)) {
    return "The trial id must be the call's instance name.";
  }
  if (t.mode !== "standard" && t.mode !== "patient") return "Unknown mode.";
  const scenario = Number(t.scenario);
  if (!Number.isInteger(scenario) || scenario < 1 || scenario > 6) return "Unknown scenario.";
  if (!TRIAL_STATUSES.includes(t.status as TrialStatus)) return "Unknown trial status.";
  const status = t.status as TrialStatus;

  const transcripts = Array.isArray(t.userTranscripts)
    ? t.userTranscripts.map((s) => text(s, 600)).slice(0, 12)
    : [];
  const statusReason = text(t.statusReason, 400).trim();
  const raw = (t.labels ?? {}) as Record<string, unknown>;
  const labels: TrialLabels = {
    premature: judgment(raw.premature) ?? "unknown",
    transcriptionCorrect: judgment(raw.transcriptionCorrect) ?? "unknown",
    responseAppropriate: judgment(raw.responseAppropriate) ?? "unknown",
    replyCutShort: judgment(raw.replyCutShort) ?? "unknown"
  };

  const spoke = hasConversation({ userTranscripts: transcripts });
  if (status === "counted" && !spoke) {
    return "A counted trial needs at least one recognized request. Record this call as a technical failure instead.";
  }
  if (status === "counted" || status === "exploratory") {
    for (const key of ["premature", "transcriptionCorrect", "responseAppropriate", "replyCutShort"]) {
      if (judgment(raw[key]) === null) return `Label "${key}" is missing.`;
    }
  }
  if ((status === "excluded" || status === "technical_failure") && statusReason.length < MIN_REASON) {
    return status === "excluded"
      ? "An excluded trial needs a reason of at least a few words."
      : "A technical failure needs a short description of what failed.";
  }

  const timings = (t.timings ?? {}) as Record<string, unknown>;
  const perceived = (t.perceived ?? {}) as Record<string, unknown>;
  const events = Array.isArray(t.events) ? t.events.slice(0, 120) : [];

  return {
    schema: 2,
    id: t.id,
    createdAt: num(t.createdAt) ?? Date.now(),
    mode: t.mode,
    scenario,
    run: 0,
    eotThreshold: Number(t.eotThreshold) || 0,
    status,
    statusReason,
    failureCode: text(t.failureCode, 60),
    userTranscripts: transcripts,
    agentReply: text(t.agentReply, 1200),
    turnCount: transcripts.length,
    cutOffPresses: num(t.cutOffPresses) ?? 0,
    // A technical failure has nothing to judge, whatever the client sent.
    labels: status === "technical_failure" ? { ...UNKNOWN_LABELS } : labels,
    timings: {
      speechStartToFinalMs: num(timings.speechStartToFinalMs),
      afterTranscribeMs: num(timings.afterTranscribeMs),
      modelToFirstTextMs: num(timings.modelToFirstTextMs),
      ttsToFirstAudioMs: num(timings.ttsToFirstAudioMs),
      finalInputToFirstAudioMs: num(timings.finalInputToFirstAudioMs),
      turnTotalMs: num(timings.turnTotalMs),
      outcome: text(timings.outcome, 40) || undefined
    },
    perceived: {
      approxSpeechEndToFirstAudioMs: num(perceived.approxSpeechEndToFirstAudioMs),
      approxPausesMs: Array.isArray(perceived.approxPausesMs)
        ? perceived.approxPausesMs.map(num).filter((n): n is number => n !== undefined).slice(0, 8)
        : []
    },
    events: events
      .filter((e): e is Record<string, unknown> => !!e && typeof e === "object")
      .map((e) => ({
        t: num(e.t) ?? 0,
        type: text(e.type, 40),
        ...(typeof e.detail === "string" ? { detail: text(e.detail, 200) } : {})
      })),
    repaired: Boolean(t.repaired),
    notes: text(t.notes, 1000).trim()
  };
}

/** Rows saved before schema 2 used booleans and two flags. Read them as schema 2. */
export function upgradeTrial(row: unknown): Trial {
  const r = row as Record<string, unknown>;
  if (r.schema === 2) return row as Trial;
  const old = (r.labels ?? {}) as Record<string, unknown>;
  const yn = (v: unknown): Judgment => (v === true ? "yes" : v === false ? "no" : "unknown");
  const transcripts = Array.isArray(r.userTranscripts) ? r.userTranscripts.map(String) : [];
  return {
    schema: 2,
    id: String(r.id),
    createdAt: Number(r.createdAt) || 0,
    mode: r.mode === "patient" ? "patient" : "standard",
    scenario: Number(r.scenario) || 1,
    run: 0,
    eotThreshold: Number(r.eotThreshold) || 0,
    // Old rows predate the planned matrix, so none of them is counted.
    status: r.excluded ? "excluded" : "exploratory",
    statusReason: String(r.excludedReason ?? ""),
    failureCode: "",
    userTranscripts: transcripts,
    agentReply: String(r.agentReply ?? ""),
    turnCount: transcripts.length,
    cutOffPresses: 0,
    labels: {
      premature: yn(old.prematureInterruption),
      transcriptionCorrect: yn(old.transcriptionCorrect),
      responseAppropriate: yn(old.responseAppropriate),
      replyCutShort: "unknown"
    },
    timings: (r.timings ?? {}) as TrialTimings,
    perceived: (r.perceived ?? {}) as PerceivedTiming,
    events: [],
    repaired: Boolean(r.repaired),
    notes: String(r.notes ?? "")
  };
}

// --- CSV ----------------------------------------------------------------------

export const CSV_COLUMNS = [
  "id",
  "created_at",
  "status",
  "status_reason",
  "failure_code",
  "mode",
  "eot_threshold",
  "scenario",
  "run",
  "sdk_committed_turns",
  "sdk_split",
  "manual_premature",
  "manual_transcription_correct",
  "manual_response_appropriate",
  "manual_reply_cut_short",
  "cut_off_presses",
  "typed_repair",
  "turn_succeeded",
  "sdk_speech_start_to_final_ms",
  "sdk_after_transcribe_ms",
  "sdk_model_to_first_text_ms",
  "sdk_tts_to_first_audio_ms",
  "sdk_final_input_to_first_audio_ms",
  "sdk_turn_total_ms",
  "sdk_turn_outcome",
  "approx_perceived_wait_ms",
  "approx_pauses_ms",
  "user_transcripts",
  "agent_reply",
  "notes"
] as const;

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (it starts
 * with = + - @, tab or carriage return) gets a leading apostrophe, so a
 * transcript like "=HYPERLINK(...)" stays text. Numbers are passed as numbers
 * and are not touched.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "1" : "0";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function trialsToCsv(trials: Trial[]): string {
  const rows = [CSV_COLUMNS.join(",")];
  for (const t of trials) {
    const ok = turnSucceeded(t);
    rows.push(
      [
        t.id,
        new Date(t.createdAt).toISOString(),
        t.status,
        t.statusReason,
        t.failureCode,
        t.mode,
        t.eotThreshold,
        t.scenario,
        t.run,
        t.turnCount,
        isSplit(t),
        t.labels.premature,
        t.labels.transcriptionCorrect,
        t.labels.responseAppropriate,
        t.labels.replyCutShort,
        t.cutOffPresses,
        t.repaired,
        ok === null ? "unknown" : ok ? "yes" : "no",
        t.timings.speechStartToFinalMs,
        t.timings.afterTranscribeMs,
        t.timings.modelToFirstTextMs,
        t.timings.ttsToFirstAudioMs,
        t.timings.finalInputToFirstAudioMs,
        t.timings.turnTotalMs,
        t.timings.outcome,
        t.perceived.approxSpeechEndToFirstAudioMs,
        (t.perceived.approxPausesMs ?? []).join(" "),
        t.userTranscripts.join(" | "),
        t.agentReply,
        t.notes
      ]
        .map(csvCell)
        .join(",")
    );
  }
  return `${rows.join("\n")}\n`;
}
