import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useVoiceAgent } from "agents/voice/react";
import { AGENT_FOR_MODE, type Mode, STARTUP_TIMEOUT_MS } from "../config";
import { canEnd, canStart, IDLE, reduce, wantsConnection } from "../lib/callMachine";
import { classifyMicError, type FailureCode } from "../lib/failures";
import type { TrialEvent, TrialTimings } from "../lib/trial";

/** The level the SDK's own client treats as a voice. */
const VOICE_LEVEL = 0.04;
/** Silence shorter than this is a gap between words, not a pause. */
const PAUSE_MIN_MS = 700;
/** With auto-end on, the call closes this long after the reply once the room is quiet. */
const QUIET_AFTER_REPLY_MS = 1500;

export interface Line {
  role: "user" | "assistant";
  text: string;
}

interface TurnSummary extends TrialTimings {
  turnId: string;
  source: string;
  outcome: string;
}

/** Everything observed during one call. Becomes a trial once a person labels it. */
export interface Capture {
  name: string;
  mode: Mode;
  scenario: number;
  lines: Line[];
  turns: TurnSummary[];
  events: TrialEvent[];
  cutOffs: number;
  repaired: boolean;
  perceivedMs?: number;
  pausesMs: number[];
  /** The call reached "listening". */
  wasLive: boolean;
  failure: FailureCode | null;
  /** The provider's own words, when it gave any. */
  failureDetail: string;
}

async function checkMicrophone(): Promise<FailureCode | null> {
  if (!navigator.mediaDevices?.getUserMedia) return "mic_unsupported";
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    for (const track of stream.getTracks()) track.stop();
    return null;
  } catch (e) {
    return classifyMicError(e instanceof Error ? e.name : "");
  }
}

function sdkErrorCode(message: string): FailureCode {
  if (/microphone/i.test(message)) return "mic_denied";
  if (/connection was lost/i.test(message)) return "stt_connection_lost";
  if (/failed to start/i.test(message)) return "stt_startup_failed";
  return "unknown";
}

export function useCall(opts: {
  autoEnd: boolean;
  onSettled: (capture: Capture) => void;
  onSessionExpired: () => void;
}) {
  const [state, dispatch] = useReducer(reduce, IDLE);
  const [target, setTarget] = useState<{ name: string; mode: Mode }>({
    name: "trial-idle",
    mode: "standard"
  });
  /** When the current silence began, while the speaker is mid-script. Drives the pause timer. */
  const [silenceSince, setSilenceSince] = useState<number | null>(null);
  const [pausesHeld, setPausesHeld] = useState(0);
  const [cutOffs, setCutOffs] = useState(0);

  const voice = useVoiceAgent({
    agent: AGENT_FOR_MODE[target.mode],
    name: target.name,
    enabled: wantsConnection(state)
  });

  const capture = useRef<Capture | null>(null);
  /** Bumped on every start and cancel, so a slow step from an old attempt is ignored. */
  const attempt = useRef(0);
  const startSent = useRef(false);
  const errorArmed = useRef(false);
  const staleError = useRef<string | null>(null);
  const staleTranscript = useRef<unknown>(null);
  const staleMetrics = useRef<unknown>(null);
  const providerFailure = useRef<{ code: FailureCode; detail: string } | null>(null);
  const readyAt = useRef(0);
  const lastVoiceAt = useRef<number | null>(null);
  const speaking = useRef(false);
  const speechEndAtCommit = useRef<number | null>(null);
  const settledFor = useRef("");
  const latest = useRef({ voice, opts, state });
  latest.current = { voice, opts, state };

  const log = useCallback((type: string, detail?: string) => {
    const c = capture.current;
    if (!c || c.events.length >= 100) return;
    const t = readyAt.current ? Math.round(performance.now() - readyAt.current) : 0;
    c.events.push(detail === undefined ? { t, type } : { t, type, detail });
  }, []);

  const start = useCallback(async (mode: Mode, scenario: number) => {
    if (!canStart(latest.current.state)) return;
    const mine = ++attempt.current;
    const name = `trial-${crypto.randomUUID()}`;
    capture.current = {
      name,
      mode,
      scenario,
      lines: [],
      turns: [],
      events: [],
      cutOffs: 0,
      repaired: false,
      pausesMs: [],
      wasLive: false,
      failure: null,
      failureDetail: ""
    };
    startSent.current = false;
    errorArmed.current = false;
    providerFailure.current = null;
    readyAt.current = 0;
    lastVoiceAt.current = null;
    speaking.current = false;
    speechEndAtCommit.current = null;
    settledFor.current = "";
    staleError.current = latest.current.voice.error;
    staleTranscript.current = latest.current.voice.transcript;
    staleMetrics.current = latest.current.voice.turnMetrics;
    setSilenceSince(null);
    setPausesHeld(0);
    setCutOffs(0);
    dispatch({ type: "START" });

    // 1. Microphone first, so a blocked mic never costs a call slot.
    const micFailure = await checkMicrophone();
    if (attempt.current !== mine) return;
    if (micFailure) {
      dispatch({ type: "FAIL", code: micFailure });
      return;
    }

    // 2. Reserve the slot over plain HTTP, where a refusal comes with a reason.
    try {
      const res = await fetch("/api/call", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name, mode })
      });
      if (attempt.current !== mine) return;
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { code?: string };
        const code = (res.status === 401 ? "session_expired" : (body.code ?? "unknown")) as FailureCode;
        dispatch({ type: "FAIL", code });
        if (res.status === 401) latest.current.opts.onSessionExpired();
        return;
      }
    } catch {
      if (attempt.current === mine) dispatch({ type: "FAIL", code: "network" });
      return;
    }

    // 3. Open the socket for exactly this call.
    setTarget({ name, mode });
    dispatch({ type: "MIC_OK" });
  }, []);

  const end = useCallback(() => {
    const { state: s, voice: v } = latest.current;
    if (!canEnd(s)) return;
    const c = capture.current;
    if (s.phase === "checking_mic" || s.phase === "connecting") {
      // Cancelled before it was a call: release everything and give the slot back.
      attempt.current++;
      v.endCall();
      if (c) {
        void fetch("/api/call-cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: c.name })
        }).catch(() => {});
      }
      capture.current = null;
    } else {
      log("call_end", "ended by the person");
      v.endCall();
    }
    dispatch({ type: "END" });
  }, [log]);

  const cutOff = useCallback(() => {
    log("cut_off_pressed");
    setCutOffs((n) => n + 1);
  }, [log]);

  const sendCorrection = useCallback(
    (text: string) => {
      latest.current.voice.sendText(text);
      if (capture.current) capture.current.repaired = true;
      log("typed_correction", text);
    },
    [log]
  );

  const { status, connected, error, transcript, turnMetrics, audioLevel, lastCustomMessage } = voice;
  const phase = state.phase;

  // Send start_call once the socket for this call is open.
  useEffect(() => {
    if (phase !== "connecting" || !connected || startSent.current) return;
    startSent.current = true;
    latest.current.voice.startCall().catch(() => dispatch({ type: "FAIL", code: "unknown" }));
  }, [phase, connected]);

  // Give up on a call that never comes up.
  useEffect(() => {
    if (phase !== "connecting") return;
    const timer = setTimeout(() => dispatch({ type: "TIMEOUT" }), STARTUP_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  // The Worker says why Workers AI refused, just before the SDK's generic error.
  useEffect(() => {
    const m = lastCustomMessage as { type?: string; code?: string; detail?: string } | null;
    if (m?.type === "pacelab_failure" && capture.current) {
      providerFailure.current = { code: (m.code ?? "provider_error") as FailureCode, detail: m.detail ?? "" };
    }
  }, [lastCustomMessage]);

  // SDK errors. A message left over from the previous call is ignored.
  useEffect(() => {
    if (!startSent.current) return;
    if (error === null) {
      errorArmed.current = true;
      return;
    }
    if (!errorArmed.current && error === staleError.current) return;
    dispatch({ type: "FAIL", code: providerFailure.current?.code ?? sdkErrorCode(error) });
  }, [error]);

  // SDK status drives the machine while a call is open.
  useEffect(() => {
    if (!startSent.current || !wantsConnection(latest.current.state)) return;
    if (status === "listening" && !readyAt.current) {
      readyAt.current = performance.now();
      if (capture.current) capture.current.wasLive = true;
      log("call_ready");
    } else if (readyAt.current) {
      log(`status_${status}`);
    }
    dispatch({ type: "SDK_STATUS", status });
    const c = capture.current;
    if (status === "speaking" && c && c.perceivedMs === undefined && speechEndAtCommit.current !== null) {
      c.perceivedMs = Math.round(performance.now() - speechEndAtCommit.current);
    }
  }, [status, log]);

  // Voice activity from the mic level: last voice time, and the pauses the speaker holds.
  useEffect(() => {
    const c = capture.current;
    if (!c || !readyAt.current || status === "speaking") return;
    const now = performance.now();
    if (audioLevel > VOICE_LEVEL) {
      if (!speaking.current) {
        const since = lastVoiceAt.current;
        if (since !== null && now - since >= PAUSE_MIN_MS && c.lines.every((l) => l.role === "user")) {
          c.pausesMs.push(Math.round(now - since));
          setPausesHeld(c.pausesMs.length);
          log("pause_held", `${Math.round(now - since)} ms`);
        }
        speaking.current = true;
        setSilenceSince(null);
      }
      lastVoiceAt.current = now;
    } else if (speaking.current && lastVoiceAt.current !== null && now - lastVoiceAt.current > 300) {
      speaking.current = false;
      setSilenceSince(lastVoiceAt.current);
    }
  }, [audioLevel, status, log]);

  // Committed transcript lines.
  useEffect(() => {
    const c = capture.current;
    if (!c || transcript.length === 0 || transcript === staleTranscript.current) return;
    const before = c.lines.length;
    c.lines = transcript.map((t) => ({ role: t.role as Line["role"], text: t.text }));
    for (const line of c.lines.slice(before)) {
      log(line.role === "user" ? "turn_committed" : "agent_reply", line.text);
      if (line.role === "user") speechEndAtCommit.current = lastVoiceAt.current;
    }
  }, [transcript, log]);

  // Turn summaries from the SDK, once each.
  useEffect(() => {
    const c = capture.current;
    const m = turnMetrics as TurnSummary | null;
    if (!c || !m || m === staleMetrics.current || c.turns.some((t) => t.turnId === m.turnId)) return;
    c.turns.push({ ...m });
    log("turn_summary", `${m.source} ${m.outcome}`);
  }, [turnMetrics, log]);

  // Auto-end: after the first reply, once the room has been quiet for a moment.
  useEffect(() => {
    if (!opts.autoEnd || phase !== "listening") return;
    const timer = setInterval(() => {
      const c = capture.current;
      if (!c || !c.lines.some((l) => l.role === "assistant")) return;
      const quietFor = performance.now() - (lastVoiceAt.current ?? 0);
      if (!speaking.current && quietFor > QUIET_AFTER_REPLY_MS) {
        log("call_end", "auto-ended after the first reply");
        latest.current.voice.endCall();
        dispatch({ type: "END" });
      }
    }, 300);
    return () => clearInterval(timer);
  }, [opts.autoEnd, phase, log]);

  // Hand the capture over exactly once when the call stops or fails.
  useEffect(() => {
    if (phase !== "stopping" && phase !== "failed") return;
    const c = capture.current;
    if (!c || settledFor.current === c.name) {
      if (phase === "stopping") dispatch({ type: "STOPPED" });
      return;
    }
    settledFor.current = c.name;
    latest.current.voice.endCall();
    c.cutOffs = cutOffs;
    if (phase === "failed") {
      c.failure = state.failure;
      c.failureDetail = providerFailure.current?.detail ?? "";
      log("failure", state.failure ?? "unknown");
      if (!c.wasLive) {
        void fetch("/api/call-cancel", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: c.name })
        }).catch(() => {});
      }
    }
    latest.current.opts.onSettled({ ...c, lines: [...c.lines], turns: [...c.turns], events: [...c.events] });
    if (phase === "stopping") dispatch({ type: "STOPPED" });
  }, [phase, state.failure, cutOffs, log]);

  // Closing the tab mid-call releases the microphone and tells the server.
  useEffect(() => {
    const release = () => latest.current.voice.endCall();
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("pagehide", release);
      release();
    };
  }, []);

  const live = phase === "listening" || phase === "responding";
  return {
    state,
    start,
    end,
    cutOff,
    sendCorrection,
    reset: () => dispatch({ type: "RESET" }),
    live,
    cutOffs,
    lines: live || phase === "stopping" ? (transcript as Line[]) : [],
    interim: live ? voice.interimTranscript : null,
    audioLevel: live ? audioLevel : 0,
    silenceSince: live ? silenceSince : null,
    pausesHeld
  };
}
