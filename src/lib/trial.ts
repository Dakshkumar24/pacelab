/**
 * The trial record. One row per scripted request spoken to one mode.
 *
 * Three kinds of number live here, and the report never mixes them:
 *   - SDK timings: measured by the Agents SDK on the server clock.
 *   - Manual labels: judged by the person running the trial.
 *   - Approximate perceived wait: measured on the browser clock from the
 *     microphone level, so it is labelled approximate everywhere it appears.
 */

export type Mode = "standard" | "patient";

/** Manual judgments. The report marks every one of these as manual. */
export interface TrialLabels {
  /** The agent replied before the request was finished ("cut me off"). */
  prematureInterruption: boolean;
  /** Transcript captured the key intent and details. Exact wording not required. */
  transcriptionCorrect: boolean;
  /** The reply fits the complete request, not a fragment of it. */
  responseAppropriate: boolean;
}

/**
 * SDK timings for the first completed speech turn of the trial, the turn the
 * agent answered first. All optional: a field is absent when its landmark was
 * not reached.
 */
export interface TrialTimings {
  /** Flux speech start to the finalized transcript. Includes speaking time and pauses. */
  speechStartToFinalMs?: number;
  /** Time in the server's afterTranscribe hook. */
  afterTranscribeMs?: number;
  /** Model invocation to the first text delta. */
  modelToFirstTextMs?: number;
  /** First TTS invocation to the first audio sent. */
  ttsToFirstAudioMs?: number;
  /** Finalized transcript to the first audio sent by the server. */
  finalInputToFirstAudioMs?: number;
  /** Turn allocation to terminal summary. */
  turnTotalMs?: number;
  /** Terminal outcome for the turn. */
  outcome?: string;
}

/**
 * Browser-clock estimate of what the speaker experienced: from the last moment
 * the microphone level was above the voice threshold before the turn was
 * committed, to the first agent audio arriving at the browser. Approximate:
 * breaths and room noise move the speech-end estimate.
 */
export interface PerceivedTiming {
  approxSpeechEndToFirstAudioMs?: number;
}

export interface Trial {
  id: string;
  createdAt: number;
  mode: Mode;
  /** Scenario number, 1-6. */
  scenario: number;
  /** Run number within this scenario and mode. */
  run: number;
  /** The threshold actually in force, so the CSV is self-describing. */
  eotThreshold: number;
  /** Durable Object instance name, proving session isolation. */
  instanceName: string;
  /** Committed user transcripts, in order. More than one means the request was split. */
  userTranscripts: string[];
  /** The agent's first spoken reply. */
  agentReply: string;
  /** Committed user turns before the agent's first reply. Greater than 1 is a measured split. */
  turnCount: number;
  labels: TrialLabels;
  timings: TrialTimings;
  perceived: PerceivedTiming;
  /** A typed correction (sendText) was needed. */
  repaired: boolean;
  /** Excluded from the batch, e.g. a connection error. Kept with its reason. */
  excluded: boolean;
  excludedReason: string;
  /** Exploratory runs are kept but never counted in the batch report. */
  exploratory: boolean;
  notes: string;
}

/**
 * The primary metric. A turn is successful only when all three hold:
 * no premature interruption, correct understanding, and an appropriate response.
 */
export function isSuccessfulTurn(t: Trial): boolean {
  return (
    !isPremature(t) &&
    t.labels.transcriptionCorrect &&
    !t.repaired &&
    t.labels.responseAppropriate
  );
}

/** Premature by either route: the manual label, or the SDK splitting the request. */
export function isPremature(t: Trial): boolean {
  return t.labels.prematureInterruption || t.turnCount > 1;
}

export const CSV_COLUMNS = [
  "id",
  "created_at",
  "mode",
  "eot_threshold",
  "scenario",
  "run",
  "exploratory",
  "excluded",
  "excluded_reason",
  "instance_name",
  "turn_count_sdk",
  "premature_manual",
  "premature_any",
  "transcription_correct_manual",
  "response_appropriate_manual",
  "repaired",
  "successful_turn",
  "sdk_speech_start_to_final_ms",
  "sdk_after_transcribe_ms",
  "sdk_model_to_first_text_ms",
  "sdk_tts_to_first_audio_ms",
  "sdk_final_input_to_first_audio_ms",
  "sdk_turn_total_ms",
  "sdk_turn_outcome",
  "approx_perceived_wait_ms",
  "user_transcripts",
  "agent_reply",
  "notes"
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = typeof value === "boolean" ? (value ? "1" : "0") : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function trialsToCsv(trials: Trial[]): string {
  const rows = [CSV_COLUMNS.join(",")];
  for (const t of trials) {
    rows.push(
      [
        t.id,
        new Date(t.createdAt).toISOString(),
        t.mode,
        t.eotThreshold,
        t.scenario,
        t.run,
        t.exploratory,
        t.excluded,
        t.excludedReason,
        t.instanceName,
        t.turnCount,
        t.labels.prematureInterruption,
        isPremature(t),
        t.labels.transcriptionCorrect,
        t.labels.responseAppropriate,
        t.repaired,
        isSuccessfulTurn(t),
        t.timings.speechStartToFinalMs,
        t.timings.afterTranscribeMs,
        t.timings.modelToFirstTextMs,
        t.timings.ttsToFirstAudioMs,
        t.timings.finalInputToFirstAudioMs,
        t.timings.turnTotalMs,
        t.timings.outcome,
        t.perceived?.approxSpeechEndToFirstAudioMs,
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

/** Reject anything that is not a well-formed trial before it reaches storage. */
export function validateTrial(input: unknown): Trial | string {
  if (!input || typeof input !== "object") return "body must be an object";
  const t = input as Partial<Trial>;
  if (typeof t.id !== "string" || !/^[\w-]{8,64}$/.test(t.id)) return "bad id";
  if (t.mode !== "standard" && t.mode !== "patient") return "bad mode";
  if (!Number.isInteger(t.scenario) || t.scenario! < 1 || t.scenario! > 6) return "bad scenario";
  if (!Number.isInteger(t.run) || t.run! < 1 || t.run! > 99) return "bad run";
  if (!t.labels || typeof t.labels !== "object") return "missing labels";
  if (!Array.isArray(t.userTranscripts)) return "missing transcripts";
  if (JSON.stringify(input).length > 20_000) return "trial too large";
  return {
    id: t.id,
    createdAt: Number(t.createdAt) || Date.now(),
    mode: t.mode,
    scenario: t.scenario!,
    run: t.run!,
    eotThreshold: Number(t.eotThreshold),
    instanceName: String(t.instanceName ?? ""),
    userTranscripts: t.userTranscripts.map(String).slice(0, 20),
    agentReply: String(t.agentReply ?? ""),
    turnCount: Number(t.turnCount) || 0,
    labels: {
      prematureInterruption: Boolean(t.labels.prematureInterruption),
      transcriptionCorrect: Boolean(t.labels.transcriptionCorrect),
      responseAppropriate: Boolean(t.labels.responseAppropriate)
    },
    timings: t.timings ?? {},
    perceived: t.perceived ?? {},
    repaired: Boolean(t.repaired),
    excluded: Boolean(t.excluded),
    excludedReason: String(t.excludedReason ?? ""),
    exploratory: Boolean(t.exploratory),
    notes: String(t.notes ?? "").slice(0, 1000)
  };
}
