import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVoiceAgent } from "agents/voice/react";
import { AGENT_FOR_MODE, EOT_THRESHOLD, type Mode, MODES } from "./config";

/**
 * The session token lives in an HttpOnly cookie, so this page cannot read it
 * and never puts it in a URL. All that is kept here is a flag saying the
 * passphrase was accepted; the server is still the thing that decides.
 */
interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
}

function useSession() {
  const [signedIn, setSignedIn] = useState(
    () => sessionStorage.getItem("pacelab-signed-in") === "1"
  );
  const enter = useCallback(() => {
    sessionStorage.setItem("pacelab-signed-in", "1");
    setSignedIn(true);
  }, []);
  const leave = useCallback(() => {
    sessionStorage.removeItem("pacelab-signed-in");
    setSignedIn(false);
  }, []);
  return { signedIn, enter, leave };
}

function Gate({ onEnter }: { onEnter: () => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: value })
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not sign in.");
        return;
      }
      setValue("");
      onEnter();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Passphrase</h2>
      <p className="muted">
        This testbench spends Workers AI credit, so it is not open to the web.
      </p>
      <label htmlFor="pass">Passphrase</label>
      <input
        id="pass"
        type="password"
        autoComplete="current-password"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        required
      />
      <button type="submit" disabled={busy || !value}>
        {busy ? "Checking…" : "Enter"}
      </button>
      <p className="error" role="alert">
        {error ?? ""}
      </p>
    </form>
  );
}

function Testbench({ onExpired }: { onExpired: () => void }) {
  const [mode, setMode] = useState<Mode>("standard");
  /** A fresh instance per call, so no conversation history carries over. */
  const [instance, setInstance] = useState(() => `trial-${crypto.randomUUID()}`);
  /**
   * The WebSocket is opened only while a call is active. Each connection
   * reserves one slot against the server's daily cap, so connecting on page
   * load or on every mode switch would spend slots without a single call.
   */
  const [active, setActive] = useState(false);
  const pendingStart = useRef(false);
  const callStarted = useRef(false);
  const [repair, setRepair] = useState("");
  const [cutOffAt, setCutOffAt] = useState<number[]>([]);
  const [usage, setUsage] = useState<{ used: number; cap: number } | null>(null);
  const [saved, setSaved] = useState<TranscriptLine[]>([]);
  const [startError, setStartError] = useState<string | null>(null);

  const voice = useVoiceAgent({
    agent: AGENT_FOR_MODE[mode],
    name: instance,
    enabled: active
  });

  const { status, connected, error, transcript, interimTranscript } = voice;
  const inCall = active;

  const refreshUsage = useCallback(async () => {
    const res = await fetch("/api/usage");
    if (res.status === 401) {
      onExpired();
      return;
    }
    if (res.ok) setUsage((await res.json()) as { used: number; cap: number });
  }, [onExpired]);

  useEffect(() => {
    void refreshUsage();
  }, [refreshUsage]);

  // Start the call once the socket for this instance is open.
  useEffect(() => {
    if (!active || !connected || !pendingStart.current) return;
    pendingStart.current = false;
    voice
      .startCall()
      .then(() => {
        callStarted.current = true;
        void refreshUsage();
      })
      .catch((e: unknown) => {
        setStartError(e instanceof Error ? e.message : "Could not start the call.");
        setActive(false);
      });
  }, [active, connected, voice, refreshUsage]);

  // A refused connection (no session, cap reached) must not retry in a loop.
  useEffect(() => {
    if (active && error && !callStarted.current) {
      setStartError(error);
      setActive(false);
      void refreshUsage();
    }
  }, [active, error, refreshUsage]);

  // The server force-ends calls at the time limit; close the socket with it.
  useEffect(() => {
    if (active && callStarted.current && status === "idle") {
      setActive(false);
      void refreshUsage();
    }
  }, [active, status, refreshUsage]);

  // Keep the transcript after the socket closes, for labelling.
  useEffect(() => {
    if (transcript.length > 0) {
      setSaved(transcript.map((t) => ({ role: t.role, text: t.text })));
    }
  }, [transcript]);

  function startCall() {
    setCutOffAt([]);
    setSaved([]);
    setStartError(null);
    callStarted.current = false;
    pendingStart.current = true;
    setInstance(`trial-${crypto.randomUUID()}`);
    setActive(true);
  }

  function endCall() {
    voice.endCall();
    setActive(false);
    void refreshUsage();
  }

  const lines = useMemo(
    () =>
      (active ? transcript : saved).map((t, i) => ({
        key: `${i}-${t.role}`,
        role: t.role,
        text: t.text
      })),
    [active, transcript, saved]
  );

  return (
    <>
      <section className="card">
        <h2>Mode</h2>
        <div className="modes" role="radiogroup" aria-label="Turn-taking mode">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? "mode on" : "mode"}
              disabled={inCall}
              onClick={() => setMode(m)}
            >
              <span className="mode-name">{m === "standard" ? "Standard" : "Patient"}</span>
              <span className="mode-sub">eotThreshold {EOT_THRESHOLD[m]}</span>
            </button>
          ))}
        </div>
        <p className="muted">
          Same prompt, model and voice in both. The threshold is the only difference.
        </p>
      </section>

      <section className="card">
        <h2>Call</h2>
        <div className="row">
          <button type="button" onClick={startCall} disabled={inCall}>
            Start call
          </button>
          <button type="button" onClick={endCall} disabled={!inCall}>
            End call
          </button>
          <button
            type="button"
            onClick={() => setCutOffAt((prev) => [...prev, Date.now()])}
            disabled={!inCall}
          >
            Cut me off
          </button>
        </div>
        <p aria-live="polite">
          <strong>Status:</strong> {active ? (connected ? status : "connecting") : "idle"}
          {usage ? ` · ${usage.used}/${usage.cap} calls used today` : ""}
          {cutOffAt.length > 0 ? ` · ${cutOffAt.length} interruptions flagged` : ""}
        </p>
        {startError || (active && error) ? (
          <p className="error" role="alert">
            {startError ?? error}
          </p>
        ) : null}
      </section>

      <section className="card">
        <h2>Transcript</h2>
        <ul className="transcript" aria-live="polite">
          {lines.map((l) => (
            <li key={l.key} className={l.role}>
              <span className="who">{l.role === "user" ? "You" : "Agent"}</span>
              <span>{l.text}</span>
            </li>
          ))}
          {active && interimTranscript ? (
            <li className="user interim">
              <span className="who">You</span>
              <span>{interimTranscript}…</span>
            </li>
          ) : null}
          {lines.length === 0 && !(active && interimTranscript) ? (
            <li className="muted">Nothing yet. Start a call and speak.</li>
          ) : null}
        </ul>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!repair.trim()) return;
            voice.sendText(repair.trim());
            setRepair("");
          }}
        >
          <label className="sr-only" htmlFor="repair">
            Correction, sent as text
          </label>
          <input
            id="repair"
            value={repair}
            placeholder="Correction (skips speech recognition)"
            onChange={(e) => setRepair(e.target.value)}
            disabled={!inCall}
          />
          <button type="submit" disabled={!inCall || !repair.trim()}>
            Send
          </button>
        </form>
      </section>

      <section className="card">
        <h2>SDK timings</h2>
        {voice.turnMetrics ? (
          <dl className="metrics">
            <dt>speech start → final transcript</dt>
            <dd>{voice.turnMetrics.speechStartToFinalMs ?? "—"} ms</dd>
            <dt>final input → first audio</dt>
            <dd>{voice.turnMetrics.finalInputToFirstAudioMs ?? "—"} ms</dd>
            <dt>model → first text</dt>
            <dd>{voice.turnMetrics.modelToFirstTextMs ?? "—"} ms</dd>
            <dt>outcome</dt>
            <dd>{voice.turnMetrics.outcome}</dd>
          </dl>
        ) : (
          <p className="muted">Measured by the SDK after the first turn.</p>
        )}
      </section>
    </>
  );
}

export function App() {
  const { signedIn, enter, leave } = useSession();
  return (
    <main className="shell">
      <header>
        <h1>PaceLab</h1>
        <p className="tagline">Compare. Diagnose. Improve.</p>
      </header>
      {signedIn ? <Testbench onExpired={leave} /> : <Gate onEnter={enter} />}
    </main>
  );
}
