/**
 * The trial record. One row per scripted request spoken to one mode.
 *
 * Timing fields come from the SDK's server-clock metrics only. Nothing here is
 * derived from browser timestamps, so no approximate number is ever reported as
 * a precise latency. Tier 2 adds clip-relative delays measured from a known
 * speech-end mark.
 */

export type Mode = "standard" | "patient";

/** Manual judgments. The report marks every one of these as manual. */
export interface TrialLabels {
  /** Speaker pressed "cut me off": the agent replied before the request was finished. */
  prematureInterruption: boolean;
  /** Transcript captured the key intent and details. Exact wording not required. */
  transcriptionCorrect: boolean;
  /** The reply fits the complete request, not a fragment of it. */
  responseAppropriate: boolean;
}

/** SDK-measured timings. All optional: a field is absent when its landmark was not reached. */
export interface TrialTimings {
  /** turn_metrics: Flux speech start to the finalized transcript. */
  speechStartToFinalMs?: number;
  /** turn_metrics: finalized input to the first server audio send. */
  finalInputToFirstAudioMs?: number;
  /** turn_metrics: model invocation to the first text delta. */
  modelToFirstTextMs?: number;
  /** turn_metrics: turn allocation to terminal summary. */
  turnTotalMs?: number;
  /** turn_metrics: terminal outcome for the turn. */
  outcome?: string;
  /** metrics: pipeline totals, all excluding STT and browser playback. */
  llmMs?: number;
  ttsMs?: number;
  firstAudioMs?: number;
  totalMs?: number;
}

export interface Trial {
  id: string;
  createdAt: number;
  mode: Mode;
  /** Scenario number, 1-6. */
  scenario: number;
  /** Run number within this scenario and mode, 1-2. */
  run: number;
  /** The threshold actually in force, recorded so the CSV is self-describing. */
  eotThreshold: number;
  /** Durable Object instance name, proving session isolation. */
  instanceName: string;
  /** Committed user transcripts, in order. More than one means the request was split. */
  userTranscripts: string[];
  /** The agent's spoken reply text. */
  agentReply: string;
  /** Count of committed user turns. Greater than 1 is a measured premature split. */
  turnCount: number;
  labels: TrialLabels;
  timings: TrialTimings;
  /** A sendText() correction was needed. */
  repaired: boolean;
  /** Excluded from the batch, e.g. a connection error. Kept with its reason. */
  excluded: boolean;
  excludedReason: string;
  notes: string;
}

/**
 * The primary metric. A turn is successful only when all three hold:
 * no premature interruption, correct understanding, and an appropriate response.
 */
export function isSuccessfulTurn(t: Trial): boolean {
  return (
    !t.labels.prematureInterruption &&
    t.turnCount === 1 &&
    t.labels.transcriptionCorrect &&
    !t.repaired &&
    t.labels.responseAppropriate
  );
}

/** Premature by either route: the manual label, or the SDK splitting one request into several turns. */
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
  "instance_name",
  "turn_count",
  "premature_manual",
  "premature_any",
  "transcription_correct_manual",
  "response_appropriate_manual",
  "repaired",
  "successful_turn",
  "speech_start_to_final_ms",
  "final_input_to_first_audio_ms",
  "model_to_first_text_ms",
  "turn_total_ms",
  "turn_outcome",
  "llm_ms",
  "tts_ms",
  "first_audio_ms",
  "total_ms",
  "excluded",
  "excluded_reason",
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
        t.instanceName,
        t.turnCount,
        t.labels.prematureInterruption,
        isPremature(t),
        t.labels.transcriptionCorrect,
        t.labels.responseAppropriate,
        t.repaired,
        isSuccessfulTurn(t),
        t.timings.speechStartToFinalMs,
        t.timings.finalInputToFirstAudioMs,
        t.timings.modelToFirstTextMs,
        t.timings.turnTotalMs,
        t.timings.outcome,
        t.timings.llmMs,
        t.timings.ttsMs,
        t.timings.firstAudioMs,
        t.timings.totalMs,
        t.excluded,
        t.excludedReason,
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
