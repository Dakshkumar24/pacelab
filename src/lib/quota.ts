/**
 * Call accounting, as pure functions so the rules can be tested without a
 * Durable Object. The store keeps one row per call and asks these functions
 * what to do.
 *
 * Three different things are counted and never confused:
 *   attempt      a reservation was made (the person pressed Start)
 *   established  speech recognition came up and the call was live
 *   failed       the call never came up; its slot is given back
 *
 * Only established and still-starting calls count against the daily cap.
 * Attempts have their own, larger cap so failed starts cannot be retried forever.
 */
import {
  AURA_NEURONS_PER_1K_CHARS,
  DAILY_ATTEMPT_CAP,
  DAILY_CALL_CAP,
  FLUX_NEURONS_PER_MINUTE,
  MAX_CALL_MS,
  NEURON_BUDGET_PER_DAY,
  STARTUP_GRACE_MS
} from "../config.ts";

export type CallState = "reserved" | "established" | "ended" | "failed";

export interface CallRow {
  name: string;
  day: string;
  mode: string;
  state: CallState;
  reservedAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Characters sent to text-to-speech. */
  ttsChars: number;
  failCode: string;
}

export type ReserveDecision =
  | { allowed: true; reuse: boolean }
  | { allowed: false; status: number; code: string; message: string };

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** The next 00:00 UTC after `now`, when both the app cap and Workers AI's allocation reset. */
export function nextUtcMidnight(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
}

/**
 * Rows that stopped reporting are settled by the clock: a reservation that
 * never became a call is a failed start, and a call that never reported its
 * end is closed at the time limit. Returns the rows that changed.
 */
export function settleStale(rows: CallRow[], now: number): CallRow[] {
  const changed: CallRow[] = [];
  for (const r of rows) {
    if (r.state === "reserved" && now - r.reservedAt > STARTUP_GRACE_MS) {
      changed.push({ ...r, state: "failed", failCode: r.failCode || "startup_timeout", endedAt: now });
    } else if (
      r.state === "established" &&
      r.startedAt !== null &&
      now - r.startedAt > MAX_CALL_MS + STARTUP_GRACE_MS
    ) {
      changed.push({ ...r, state: "ended", endedAt: r.startedAt + MAX_CALL_MS });
    }
  }
  return changed;
}

/** Decide whether a call may start. `rows` are today's rows, already settled. */
export function decideReservation(
  rows: CallRow[],
  name: string,
  mode: string
): ReserveDecision {
  const mine = rows.find((r) => r.name === name);
  if (mine) {
    // The same call reconnecting must not take a second slot or reopen a finished one.
    if (mine.mode === mode && (mine.state === "reserved" || mine.state === "established")) {
      return { allowed: true, reuse: true };
    }
    return {
      allowed: false,
      status: 409,
      code: "call_finished",
      message: "This call has already finished. Start a new one."
    };
  }
  if (rows.some((r) => r.state === "reserved" || r.state === "established")) {
    return {
      allowed: false,
      status: 409,
      code: "call_in_progress",
      message: "Another call is still open or closing. Wait a few seconds and try again."
    };
  }
  const used = rows.filter((r) => r.state !== "failed").length;
  if (used >= DAILY_CALL_CAP) {
    return {
      allowed: false,
      status: 429,
      code: "daily_cap",
      message: `Daily call cap reached (${used}/${DAILY_CALL_CAP}). It resets at 00:00 UTC.`
    };
  }
  if (rows.length >= DAILY_ATTEMPT_CAP) {
    return {
      allowed: false,
      status: 429,
      code: "attempt_cap",
      message: `Too many start attempts today (${rows.length}/${DAILY_ATTEMPT_CAP}). It resets at 00:00 UTC.`
    };
  }
  return { allowed: true, reuse: false };
}

export interface Usage {
  day: string;
  /** Calls that count against the cap: established, ended, or still starting. */
  used: number;
  cap: number;
  attempts: number;
  attemptCap: number;
  failed: number;
  /** [~] Estimated Workers AI neurons spent by this app today, from list prices. */
  estimatedNeurons: number;
  neuronBudget: number;
  /** Set when Workers AI refused a call today for lack of allocation. */
  providerExhausted: boolean;
  /** When the caps and the Workers AI allocation reset (ms since epoch). */
  resetsAt: number;
}

/**
 * Estimate today's neuron spend: Flux is billed per minute the call was open,
 * Aura per character spoken. Gemma's share is small and left out, as is
 * anything else running on the account, so this is a floor, not a bill.
 */
export function summarizeUsage(rows: CallRow[], now: number): Usage {
  let audioMs = 0;
  let chars = 0;
  for (const r of rows) {
    if (r.startedAt !== null) audioMs += Math.max(0, (r.endedAt ?? now) - r.startedAt);
    chars += r.ttsChars;
  }
  const neurons =
    (audioMs / 60_000) * FLUX_NEURONS_PER_MINUTE + (chars / 1000) * AURA_NEURONS_PER_1K_CHARS;
  return {
    day: utcDay(now),
    used: rows.filter((r) => r.state !== "failed").length,
    cap: DAILY_CALL_CAP,
    attempts: rows.length,
    attemptCap: DAILY_ATTEMPT_CAP,
    failed: rows.filter((r) => r.state === "failed").length,
    estimatedNeurons: Math.round(neurons),
    neuronBudget: NEURON_BUDGET_PER_DAY,
    providerExhausted: rows.some((r) => r.failCode === "provider_quota"),
    resetsAt: nextUtcMidnight(now)
  };
}
