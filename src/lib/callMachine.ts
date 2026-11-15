/**
 * The call lifecycle as a pure state machine. The page feeds it events and
 * draws whatever state comes back, so buttons cannot get out of step with
 * the call, and double clicks or late events have nowhere to go.
 *
 *   idle -> checking_mic -> connecting -> listening <-> responding
 *                                             |             |
 *                                             +-> stopping -+-> idle
 *   any active state -> failed -> idle | checking_mic
 */
import type { FailureCode } from "./failures.ts";

export type CallPhase =
  | "idle"
  | "checking_mic"
  | "connecting"
  | "listening"
  | "responding"
  | "stopping"
  | "failed";

export interface CallState {
  phase: CallPhase;
  /** Set in `failed`. */
  failure: FailureCode | null;
  /** The call reached `listening` at least once, so a slot was used and there may be evidence. */
  wasLive: boolean;
}

export type CallEvent =
  | { type: "START" }
  | { type: "MIC_OK" }
  | { type: "FAIL"; code: FailureCode }
  /** Status reported by the SDK for the open call. */
  | { type: "SDK_STATUS"; status: "idle" | "listening" | "thinking" | "speaking" }
  | { type: "TIMEOUT" }
  | { type: "END" }
  | { type: "STOPPED" }
  | { type: "RESET" };

export const IDLE: CallState = { phase: "idle", failure: null, wasLive: false };

const ACTIVE: CallPhase[] = ["checking_mic", "connecting", "listening", "responding"];

export function isActive(s: CallState): boolean {
  return ACTIVE.includes(s.phase) || s.phase === "stopping";
}

/** The microphone or socket should be open. */
export function wantsConnection(s: CallState): boolean {
  return s.phase === "connecting" || s.phase === "listening" || s.phase === "responding";
}

export function canStart(s: CallState): boolean {
  return s.phase === "idle" || s.phase === "failed";
}

export function canEnd(s: CallState): boolean {
  return ACTIVE.includes(s.phase);
}

export function reduce(s: CallState, e: CallEvent): CallState {
  switch (e.type) {
    case "START":
      return canStart(s) ? { phase: "checking_mic", failure: null, wasLive: false } : s;

    case "MIC_OK":
      return s.phase === "checking_mic" ? { ...s, phase: "connecting" } : s;

    case "FAIL":
      // A failure only means something while a call is being set up or is live.
      return ACTIVE.includes(s.phase) ? { ...s, phase: "failed", failure: e.code } : s;

    case "TIMEOUT":
      return s.phase === "checking_mic" || s.phase === "connecting"
        ? { ...s, phase: "failed", failure: "startup_timeout" }
        : s;

    case "SDK_STATUS":
      if (e.status === "listening") {
        if (s.phase === "connecting" || s.phase === "responding") {
          return { ...s, phase: "listening", wasLive: true };
        }
        return s;
      }
      if (e.status === "thinking" || e.status === "speaking") {
        return s.phase === "listening" ? { ...s, phase: "responding" } : s;
      }
      // "idle" from the server while live: it ended the call (time limit).
      return s.phase === "listening" || s.phase === "responding" ? { ...s, phase: "stopping" } : s;

    case "END":
      if (s.phase === "checking_mic" || s.phase === "connecting") return IDLE;
      return s.phase === "listening" || s.phase === "responding" ? { ...s, phase: "stopping" } : s;

    case "STOPPED":
      return s.phase === "stopping" ? { ...IDLE, wasLive: s.wasLive } : s;

    case "RESET":
      return s.phase === "failed" || s.phase === "idle" ? IDLE : s;
  }
}

/** Short label for the status line. */
export const PHASE_LABEL: Record<CallPhase, string> = {
  idle: "Ready",
  checking_mic: "Checking microphone",
  connecting: "Connecting",
  listening: "Listening",
  responding: "Agent responding",
  stopping: "Ending call",
  failed: "Failed"
};
