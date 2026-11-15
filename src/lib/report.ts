/**
 * Turn Failure Report. Standard and Patient side by side, per scenario.
 *
 * Only counted trials enter the rates. Every rate carries its own
 * denominator: the trials where a person gave a yes or no. "Unable to
 * determine" is reported beside the rate and never inside it. Technical
 * failures are counted separately and never in a denominator.
 */
import { buildProgress, type Progress, SCENARIO_IDS } from "./experiment.ts";
import { isSplit, type Judgment, type Mode, type Trial, turnSucceeded } from "./trial.ts";

export interface Rate {
  yes: number;
  /** Trials judged yes or no. The denominator. */
  judged: number;
  unknown: number;
}

export interface Spread {
  n: number;
  median: number | null;
  min: number | null;
  max: number | null;
}

export interface Example {
  id: string;
  transcripts: string[];
  reply: string;
  notes: string;
}

export interface ModeCell {
  mode: Mode;
  /** Counted trials. */
  trials: number;
  /** [M] */
  premature: Rate;
  transcriptionCorrect: Rate;
  responseAppropriate: Rate;
  replyCutShort: Rate;
  /** [M] all three core labels judged, and all good. */
  succeeded: Rate;
  /** [SDK] request committed as more than one turn. A fact, not a verdict. */
  sdkSplits: number;
  /** [SDK] first answered turn did not finish as "completed". */
  sdkReplyNotCompleted: number;
  typedRepairs: number;
  /** [SDK] single-turn trials only. Includes speaking time; not latency. */
  speechStartToFinal: Spread;
  /** [SDK] */
  finalInputToFirstAudio: Spread;
  modelToFirstText: Spread;
  ttsToFirstAudio: Spread;
  /** [~] */
  perceivedWait: Spread;
  /** Not counted trials, shown for context only. */
  technicalFailures: number;
  excluded: number;
  exploratory: number;
  /** Counted trials a person labelled premature. */
  prematureExamples: Example[];
}

export interface ScenarioRow {
  scenario: number;
  standard: ModeCell;
  patient: ModeCell;
}

export type Verdict = "insufficient" | "no_clear_difference" | "patient_fewer" | "standard_fewer";

export interface Decision {
  verdict: Verdict;
  headline: string;
  /** What was tested, what failed, the trade-off, how sure to be, what next. */
  points: { label: string; text: string }[];
}

export interface Report {
  scenarios: ScenarioRow[];
  totals: { standard: ModeCell; patient: ModeCell };
  progress: Progress;
  decision: Decision;
}

function rate(values: Judgment[]): Rate {
  const yes = values.filter((v) => v === "yes").length;
  const no = values.filter((v) => v === "no").length;
  return { yes, judged: yes + no, unknown: values.length - yes - no };
}

export function spread(values: (number | undefined)[]): Spread {
  const v = values.filter((x): x is number => typeof x === "number" && x >= 0);
  if (v.length === 0) return { n: 0, median: null, min: null, max: null };
  const s = [...v].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  const median = s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  return { n: s.length, median, min: s[0], max: s[s.length - 1] };
}

/** Percent, or null when nothing was judged. */
export function percent(r: Rate): number | null {
  return r.judged === 0 ? null : Math.round((r.yes / r.judged) * 100);
}

function cell(mode: Mode, all: Trial[]): ModeCell {
  const mine = all.filter((t) => t.mode === mode);
  const counted = mine.filter((t) => t.status === "counted");
  const outcomes = counted.map(turnSucceeded);
  return {
    mode,
    trials: counted.length,
    premature: rate(counted.map((t) => t.labels.premature)),
    transcriptionCorrect: rate(counted.map((t) => t.labels.transcriptionCorrect)),
    responseAppropriate: rate(counted.map((t) => t.labels.responseAppropriate)),
    replyCutShort: rate(counted.map((t) => t.labels.replyCutShort)),
    succeeded: {
      yes: outcomes.filter((o) => o === true).length,
      judged: outcomes.filter((o) => o !== null).length,
      unknown: outcomes.filter((o) => o === null).length
    },
    sdkSplits: counted.filter(isSplit).length,
    sdkReplyNotCompleted: counted.filter(
      (t) => t.timings.outcome !== undefined && t.timings.outcome !== "completed"
    ).length,
    typedRepairs: counted.filter((t) => t.repaired).length,
    speechStartToFinal: spread(
      counted.filter((t) => !isSplit(t)).map((t) => t.timings.speechStartToFinalMs)
    ),
    finalInputToFirstAudio: spread(counted.map((t) => t.timings.finalInputToFirstAudioMs)),
    modelToFirstText: spread(counted.map((t) => t.timings.modelToFirstTextMs)),
    ttsToFirstAudio: spread(counted.map((t) => t.timings.ttsToFirstAudioMs)),
    perceivedWait: spread(counted.map((t) => t.perceived.approxSpeechEndToFirstAudioMs)),
    technicalFailures: mine.filter((t) => t.status === "technical_failure").length,
    excluded: mine.filter((t) => t.status === "excluded").length,
    exploratory: mine.filter((t) => t.status === "exploratory").length,
    prematureExamples: counted
      .filter((t) => t.labels.premature === "yes")
      .slice(0, 2)
      .map((t) => ({
        id: t.id,
        transcripts: t.userTranscripts,
        reply: t.agentReply,
        notes: t.notes
      }))
  };
}

/** Fewest judged trials per mode before the report will compare the modes at all. */
export const MIN_JUDGED_PER_MODE = 6;

function frac(r: Rate): string {
  return `${r.yes} of ${r.judged}`;
}

/**
 * A cautious reading of the totals. It never claims significance: with 12
 * trials per mode and one speaker, the most it can say is which mode did
 * better in these samples.
 */
export function buildDecision(
  standard: ModeCell,
  patient: ModeCell,
  progress: Progress
): Decision {
  const s = standard.premature;
  const p = patient.premature;
  const missing = progress.planned - progress.valid;
  const next = progress.next
    ? `Run scenario ${progress.next.scenario} in ${progress.next.mode} mode (repeat ${progress.next.repeat}). ${missing} planned trials remain.`
    : "The matrix is complete. Repeat it with a second speaker, or with recorded audio so both modes hear the same input.";

  if (s.judged < MIN_JUDGED_PER_MODE || p.judged < MIN_JUDGED_PER_MODE) {
    return {
      verdict: "insufficient",
      headline: "Insufficient evidence",
      points: [
        {
          label: "Why",
          text: `A comparison needs at least ${MIN_JUDGED_PER_MODE} judged trials per mode. So far: Standard ${s.judged}, Patient ${p.judged}.`
        },
        { label: "Next", text: next }
      ]
    };
  }

  const gap = s.yes / s.judged - p.yes / p.judged;
  // Under two trials' worth of difference is inside what one odd run can produce.
  const small = Math.abs(s.yes - p.yes) < 2 || Math.abs(gap) < 0.15;
  const verdict: Verdict = small
    ? "no_clear_difference"
    : gap > 0
      ? "patient_fewer"
      : "standard_fewer";
  const headline =
    verdict === "no_clear_difference"
      ? "No clear difference in premature responses"
      : verdict === "patient_fewer"
        ? "Patient had fewer premature responses in these samples"
        : "Standard had fewer premature responses in these samples";

  const sw = standard.perceivedWait;
  const pw = patient.perceivedWait;
  const tradeOff =
    sw.n >= 3 && pw.n >= 3 && sw.median !== null && pw.median !== null
      ? `Approximate perceived wait, median: Standard ${sw.median} ms (n=${sw.n}), Patient ${pw.median} ms (n=${pw.n}). Browser estimate; the model's own start-up time is in both and varies run to run.`
      : "Not enough perceived-wait measurements in both modes to describe the cost in waiting.";

  return {
    verdict,
    headline,
    points: [
      {
        label: "Tested",
        text: `Six scripted requests, with and without pauses, spoken to both modes. ${progress.valid} of ${progress.planned} planned trials are in.`
      },
      {
        label: "Premature responses",
        text: `Standard ${frac(s)} judged trials, Patient ${frac(p)}. Unable to determine: ${s.unknown + p.unknown}.`
      },
      { label: "Trade-off", text: tradeOff },
      {
        label: "Confidence",
        text: progress.complete
          ? "Directional only. One speaker, two repeats per cell, manual labels by the same person. No significance test applies at this size."
          : "Low. The matrix is incomplete, so some scenarios weigh more than others."
      },
      { label: "Next", text: next }
    ]
  };
}

export function buildReport(all: Trial[]): Report {
  const scenarios = SCENARIO_IDS.map((scenario) => {
    const inScenario = all.filter((t) => t.scenario === scenario);
    return {
      scenario,
      standard: cell("standard", inScenario),
      patient: cell("patient", inScenario)
    };
  });
  const totals = { standard: cell("standard", all), patient: cell("patient", all) };
  const progress = buildProgress(all);
  return {
    scenarios,
    totals,
    progress,
    decision: buildDecision(totals.standard, totals.patient, progress)
  };
}
