import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVoiceAgent } from "agents/voice/react";
import { AGENT_FOR_MODE, EOT_THRESHOLD, type Mode, MODES } from "./config";
import { SCENARIOS } from "./lib/scenarios";
import type { Trial } from "./lib/trial";
import type { ModeCell, Report, Spread } from "./lib/report";

/** Same level the SDK's own client uses to decide the microphone hears a voice. */
const VOICE_LEVEL = 0.04;

interface TranscriptLine {
  role: "user" | "assistant";
  text: string;
}

interface TurnMetricsLike {
  turnId: string;
  source: string;
  outcome: string;
  turnTotalMs?: number;
  speechStartToFinalMs?: number;
  afterTranscribeMs?: number;
  modelToFirstTextMs?: number;
  ttsToFirstAudioMs?: number;
  finalInputToFirstAudioMs?: number;
}

/** Everything captured during one call, waiting for labels before it is saved. */
interface PendingTrial {
  mode: Mode;
  scenario: number;
  instanceName: string;
  lines: TranscriptLine[];
  turns: TurnMetricsLike[];
  cutOffs: number;
  repaired: boolean;
  perceivedMs?: number;
}

/**
 * The session token lives in an HttpOnly cookie, so this page cannot read it
 * and never puts it in a URL. All that is kept here is a flag saying the
 * passphrase was accepted; the server is still the thing that decides.
 */
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

/** Split a call's transcript into the request and the agent's first reply. */
function summarize(p: PendingTrial) {
  const firstReply = p.lines.findIndex((l) => l.role === "assistant");
  const before = firstReply === -1 ? p.lines : p.lines.slice(0, firstReply);
  const userTranscripts = before.filter((l) => l.role === "user").map((l) => l.text);
  const agentReply = firstReply === -1 ? "" : p.lines[firstReply].text;
  const answered = p.turns.find(
    (t) => t.source === "speech" && t.outcome === "completed"
  );
  return { userTranscripts, agentReply, turnCount: userTranscripts.length, answered };
}

function LabelForm({
  pending,
  run,
  onSaved,
  onDiscard,
  onExpired
}: {
  pending: PendingTrial;
  run: number;
  onSaved: () => void;
  onDiscard: () => void;
  onExpired: () => void;
}) {
  const s = useMemo(() => summarize(pending), [pending]);
  const measuredSplit = s.turnCount > 1;
  const [premature, setPremature] = useState(pending.cutOffs > 0 || measuredSplit);
  const [transcription, setTranscription] = useState<"" | "yes" | "no">("");
  const [response, setResponse] = useState<"" | "yes" | "no">("");
  const [repaired, setRepaired] = useState(pending.repaired);
  const [exploratory, setExploratory] = useState(false);
  const [excluded, setExcluded] = useState(false);
  const [excludedReason, setExcludedReason] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ready = transcription !== "" && response !== "" && (!excluded || excludedReason.trim());

  async function save() {
    setBusy(true);
    setError(null);
    const trial: Trial = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      mode: pending.mode,
      scenario: pending.scenario,
      run,
      eotThreshold: EOT_THRESHOLD[pending.mode],
      instanceName: pending.instanceName,
      userTranscripts: s.userTranscripts,
      agentReply: s.agentReply,
      turnCount: s.turnCount,
      labels: {
        prematureInterruption: premature,
        transcriptionCorrect: transcription === "yes",
        responseAppropriate: response === "yes"
      },
      timings: s.answered
        ? {
            speechStartToFinalMs: s.answered.speechStartToFinalMs,
            afterTranscribeMs: s.answered.afterTranscribeMs,
            modelToFirstTextMs: s.answered.modelToFirstTextMs,
            ttsToFirstAudioMs: s.answered.ttsToFirstAudioMs,
            finalInputToFirstAudioMs: s.answered.finalInputToFirstAudioMs,
            turnTotalMs: s.answered.turnTotalMs,
            outcome: s.answered.outcome
          }
        : {},
      perceived: { approxSpeechEndToFirstAudioMs: pending.perceivedMs },
      repaired,
      excluded,
      excludedReason: excluded ? excludedReason.trim() : "",
      exploratory,
      notes: notes.trim()
    };
    try {
      const res = await fetch("/api/trial", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(trial)
      });
      if (res.status === 401) {
        onExpired();
        return;
      }
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Save failed (${res.status}).`);
        return;
      }
      onSaved();
    } catch {
      setError("Network error. Nothing was saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="label-heading">
      <h2 id="label-heading">
        Label trial: {pending.mode === "standard" ? "Standard" : "Patient"}, scenario{" "}
        {pending.scenario}, run {run}
      </h2>
      <dl className="metrics">
        <dt>Your request [SDK turns]</dt>
        <dd>
          {s.userTranscripts.length ? s.userTranscripts.join(" | ") : "none committed"}
        </dd>
        <dt>Committed turns before the reply [SDK]</dt>
        <dd>
          {s.turnCount}
          {measuredSplit ? " (split: measured premature)" : ""}
        </dd>
        <dt>Agent's first reply</dt>
        <dd>{s.agentReply || "no reply"}</dd>
        <dt>"Cut me off" presses</dt>
        <dd>{pending.cutOffs}</dd>
      </dl>

      <fieldset>
        <legend>Premature [manual]</legend>
        <label className="inline">
          <input
            type="checkbox"
            checked={premature}
            onChange={(e) => setPremature(e.target.checked)}
          />{" "}
          The agent answered before I finished the request
        </label>
      </fieldset>

      <fieldset>
        <legend>Transcription correct [manual]</legend>
        <p className="muted">Key intent and details captured. Exact wording not required.</p>
        {(["yes", "no"] as const).map((v) => (
          <label className="inline" key={v}>
            <input
              type="radio"
              name="transcription"
              checked={transcription === v}
              onChange={() => setTranscription(v)}
            />{" "}
            {v === "yes" ? "Yes" : "No"}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Response appropriate [manual]</legend>
        <p className="muted">Fits the whole request, not a fragment of it.</p>
        {(["yes", "no"] as const).map((v) => (
          <label className="inline" key={v}>
            <input
              type="radio"
              name="response"
              checked={response === v}
              onChange={() => setResponse(v)}
            />{" "}
            {v === "yes" ? "Yes" : "No"}
          </label>
        ))}
      </fieldset>

      <fieldset>
        <legend>Other</legend>
        <label className="inline">
          <input
            type="checkbox"
            checked={repaired}
            onChange={(e) => setRepaired(e.target.checked)}
          />{" "}
          Needed a typed correction
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={exploratory}
            onChange={(e) => setExploratory(e.target.checked)}
          />{" "}
          Exploratory (kept, not counted in the report)
        </label>
        <label className="inline">
          <input
            type="checkbox"
            checked={excluded}
            onChange={(e) => setExcluded(e.target.checked)}
          />{" "}
          Exclude (connection error or similar)
        </label>
        {excluded ? (
          <>
            <label htmlFor="excl">Exclusion reason</label>
            <input
              id="excl"
              value={excludedReason}
              onChange={(e) => setExcludedReason(e.target.value)}
            />
          </>
        ) : null}
        <label htmlFor="notes">Notes</label>
        <input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </fieldset>

      <div className="row">
        <button type="button" onClick={save} disabled={!ready || busy}>
          {busy ? "Saving…" : "Save trial"}
        </button>
        <button type="button" onClick={onDiscard} disabled={busy}>
          Discard
        </button>
      </div>
      <p className="error" role="alert">
        {error ?? ""}
      </p>
    </section>
  );
}

function fmt(s: Spread): string {
  if (s.n === 0 || s.median === null) return "—";
  return `${s.median} / ${s.worst} ms (n=${s.n})`;
}

function ReportView({ report }: { report: Report | null }) {
  if (!report) return <p className="muted">Loading report…</p>;
  if (report.counted === 0) {
    return (
      <p className="muted">
        No counted trials yet. {report.exploratory} exploratory, {report.excluded} excluded.
      </p>
    );
  }
  const rows: { label: string; tag: string; get: (c: ModeCell) => string }[] = [
    { label: "Trials", tag: "", get: (c) => String(c.trials) },
    {
      label: "Successful turns",
      tag: "M+SDK",
      get: (c) => `${c.successfulTurns}/${c.trials}`
    },
    {
      label: "Premature (any)",
      tag: "M+SDK",
      get: (c) => `${c.prematureTurns}/${c.trials}`
    },
    {
      label: "…of which split by SDK",
      tag: "SDK",
      get: (c) => `${c.prematureMeasured}/${c.trials}`
    },
    {
      label: "Transcription correct",
      tag: "M",
      get: (c) => `${c.transcriptionCorrect}/${c.trials}`
    },
    {
      label: "Response appropriate",
      tag: "M",
      get: (c) => `${c.responseAppropriate}/${c.trials}`
    },
    { label: "Typed repairs", tag: "M", get: (c) => String(c.repairs) },
    {
      label: "Speech start → final, single-turn only",
      tag: "SDK",
      get: (c) => fmt(c.speechStartToFinal)
    },
    { label: "Final input → first audio", tag: "SDK", get: (c) => fmt(c.finalInputToFirstAudio) },
    { label: "…model → first text", tag: "SDK", get: (c) => fmt(c.modelToFirstText) },
    { label: "…TTS → first audio", tag: "SDK", get: (c) => fmt(c.ttsToFirstAudio) },
    { label: "Perceived wait", tag: "≈", get: (c) => fmt(c.perceivedWait) }
  ];

  return (
    <>
      <p className="muted">
        Tags: [M] manual label · [SDK] Agents SDK, server clock · [≈] approximate,
        browser clock (last voice level above threshold → first agent audio).
        Timings are median / worst. {report.counted} counted, {report.exploratory}{" "}
        exploratory and {report.excluded} excluded trials are not shown.
      </p>
      {report.scenarios.map((row) => {
        const sc = SCENARIOS.find((x) => x.id === row.scenario);
        return (
          <table className="report" key={row.scenario}>
            <caption>
              Scenario {row.scenario}: {sc?.name ?? ""}
            </caption>
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col">Standard ({EOT_THRESHOLD.standard})</th>
                <th scope="col">Patient ({EOT_THRESHOLD.patient})</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.label}>
                  <th scope="row">
                    {r.label} {r.tag ? <span className="tag">[{r.tag}]</span> : null}
                  </th>
                  <td>{r.get(row.standard)}</td>
                  <td>{r.get(row.patient)}</td>
                </tr>
              ))}
              <tr>
                <th scope="row">
                  Added delay, Patient − Standard <span className="tag">[SDK, directional]</span>
                </th>
                <td colSpan={2}>
                  {row.addedDelayDirectionalMs === null
                    ? "needs a single-turn trial in both modes"
                    : `${row.addedDelayDirectionalMs} ms`}
                </td>
              </tr>
            </tbody>
          </table>
        );
      })}
    </>
  );
}

function Testbench({ onExpired }: { onExpired: () => void }) {
  const [mode, setMode] = useState<Mode>("standard");
  const [scenario, setScenario] = useState(1);
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
  const [usage, setUsage] = useState<{ used: number; cap: number } | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [trials, setTrials] = useState<Trial[]>([]);
  const [pending, setPending] = useState<PendingTrial | null>(null);

  // Per-call capture, reset at the start of every call.
  const call = useRef<PendingTrial | null>(null);
  const lastVoiceAt = useRef<number | null>(null);
  const speechEndAtCommit = useRef<number | null>(null);
  /**
   * The hook can still hold the previous call's transcript and turn summary
   * when a new call starts. Turn IDs restart at turn_1 for every agent
   * instance, so a stale summary would be captured and the new call's real
   * turn_1 then dropped as a duplicate. Both are snapshotted at Start and skipped.
   */
  const staleTranscript = useRef<unknown>(null);
  const staleMetrics = useRef<unknown>(null);
  const [cutOffs, setCutOffs] = useState(0);

  const voice = useVoiceAgent({
    agent: AGENT_FOR_MODE[mode],
    name: instance,
    enabled: active
  });

  const { status, connected, error, transcript, interimTranscript, audioLevel } = voice;

  const refresh = useCallback(async () => {
    const [u, r, t] = await Promise.all([
      fetch("/api/usage"),
      fetch("/api/report"),
      fetch("/api/trials")
    ]);
    if ([u, r, t].some((x) => x.status === 401)) {
      onExpired();
      return;
    }
    if (u.ok) setUsage((await u.json()) as { used: number; cap: number });
    if (r.ok) setReport((await r.json()) as Report);
    if (t.ok) setTrials(((await t.json()) as { trials: Trial[] }).trials);
  }, [onExpired]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Start the call once the socket for this instance is open.
  useEffect(() => {
    if (!active || !connected || !pendingStart.current) return;
    pendingStart.current = false;
    voice
      .startCall()
      .then(() => {
        callStarted.current = true;
        void refresh();
      })
      .catch((e: unknown) => {
        setStartError(e instanceof Error ? e.message : "Could not start the call.");
        setActive(false);
      });
  }, [active, connected, voice, refresh]);

  // A refused connection (no session, cap reached) must not retry in a loop.
  useEffect(() => {
    if (active && error && !callStarted.current) {
      setStartError(error);
      setActive(false);
      void refresh();
    }
  }, [active, error, refresh]);

  // Last moment the microphone heard a voice, on the browser clock.
  useEffect(() => {
    if (active && status === "listening" && audioLevel > VOICE_LEVEL) {
      lastVoiceAt.current = performance.now();
    }
  }, [active, status, audioLevel]);

  // Keep the call's transcript; note the speech-end estimate at each commit.
  useEffect(() => {
    const c = call.current;
    if (!c || transcript.length === 0 || transcript === staleTranscript.current) return;
    const prevUsers = c.lines.filter((l) => l.role === "user").length;
    c.lines = transcript.map((t) => ({ role: t.role, text: t.text }));
    const users = c.lines.filter((l) => l.role === "user").length;
    if (users > prevUsers) speechEndAtCommit.current = lastVoiceAt.current;
  }, [transcript]);

  // First agent audio of the call: approximate perceived wait.
  useEffect(() => {
    const c = call.current;
    if (!c || status !== "speaking" || c.perceivedMs !== undefined) return;
    if (speechEndAtCommit.current !== null) {
      c.perceivedMs = Math.round(performance.now() - speechEndAtCommit.current);
    }
  }, [status]);

  // Every turn summary the SDK sends, deduplicated by turn ID.
  useEffect(() => {
    const c = call.current;
    const m = voice.turnMetrics as TurnMetricsLike | null;
    if (!c || !m || m === staleMetrics.current) return;
    if (c.turns.some((t) => t.turnId === m.turnId)) return;
    c.turns.push({ ...m });
  }, [voice.turnMetrics]);

  const finishCall = useCallback(() => {
    setActive(false);
    const c = call.current;
    call.current = null;
    if (c && callStarted.current) {
      c.cutOffs = cutOffs;
      setPending({ ...c, lines: [...c.lines], turns: [...c.turns] });
    }
    void refresh();
  }, [cutOffs, refresh]);

  // The server force-ends calls at the time limit; close the socket with it.
  useEffect(() => {
    if (active && callStarted.current && status === "idle") finishCall();
  }, [active, status, finishCall]);

  function startCall() {
    const name = `trial-${crypto.randomUUID()}`;
    call.current = {
      mode,
      scenario,
      instanceName: name,
      lines: [],
      turns: [],
      cutOffs: 0,
      repaired: false
    };
    lastVoiceAt.current = null;
    speechEndAtCommit.current = null;
    staleTranscript.current = transcript;
    staleMetrics.current = voice.turnMetrics;
    setCutOffs(0);
    setPending(null);
    setStartError(null);
    callStarted.current = false;
    pendingStart.current = true;
    setInstance(name);
    setActive(true);
  }

  function endCall() {
    voice.endCall();
    finishCall();
  }

  const run = useMemo(() => {
    const m = pending?.mode ?? mode;
    const sc = pending?.scenario ?? scenario;
    return (
      trials.filter(
        (t) => t.mode === m && t.scenario === sc && !t.excluded && !t.exploratory
      ).length + 1
    );
  }, [trials, pending, mode, scenario]);

  const lines = active ? transcript : (pending?.lines ?? []);
  const script = SCENARIOS.find((s) => s.id === scenario);

  return (
    <>
      <section className="card">
        <h2>Setup</h2>
        <div className="modes" role="radiogroup" aria-label="Turn-taking mode">
          {MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="radio"
              aria-checked={mode === m}
              className={mode === m ? "mode on" : "mode"}
              disabled={active}
              onClick={() => setMode(m)}
            >
              <span className="mode-name">{m === "standard" ? "Standard" : "Patient"}</span>
              <span className="mode-sub">eotThreshold {EOT_THRESHOLD[m]}</span>
            </button>
          ))}
        </div>
        <label htmlFor="scenario">Scenario</label>
        <select
          id="scenario"
          value={scenario}
          disabled={active}
          onChange={(e) => setScenario(Number(e.target.value))}
        >
          {SCENARIOS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.id}. {s.name}: {s.tests}
            </option>
          ))}
        </select>
        <p className="script" aria-live="polite">
          “{script?.script}”
        </p>
        <p className="muted">Next run for this mode and scenario: {run}</p>
      </section>

      <section className="card">
        <h2>Call</h2>
        <div className="row">
          <button type="button" onClick={startCall} disabled={active || pending !== null}>
            Start call
          </button>
          <button type="button" onClick={endCall} disabled={!active}>
            End call
          </button>
          <button type="button" onClick={() => setCutOffs((n) => n + 1)} disabled={!active}>
            Cut me off
          </button>
        </div>
        <p aria-live="polite">
          <strong>Status:</strong> {active ? (connected ? status : "connecting") : "idle"}
          {usage ? ` · ${usage.used}/${usage.cap} calls used today` : ""}
          {cutOffs > 0 ? ` · ${cutOffs} interruptions flagged` : ""}
        </p>
        {pending ? (
          <p className="muted">Label or discard the last call before starting another.</p>
        ) : null}
        {startError || (active && error) ? (
          <p className="error" role="alert">
            {startError ?? error}
          </p>
        ) : null}
        <ul className="transcript" aria-live="polite">
          {lines.map((l, i) => (
            <li key={`${i}-${l.role}`} className={l.role}>
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
            <li className="muted">Nothing yet. Start a call and read the script.</li>
          ) : null}
        </ul>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            if (!repair.trim()) return;
            voice.sendText(repair.trim());
            if (call.current) call.current.repaired = true;
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
            disabled={!active}
          />
          <button type="submit" disabled={!active || !repair.trim()}>
            Send
          </button>
        </form>
      </section>

      {pending ? (
        <LabelForm
          key={pending.instanceName}
          pending={pending}
          run={run}
          onSaved={() => {
            setPending(null);
            void refresh();
          }}
          onDiscard={() => setPending(null)}
          onExpired={onExpired}
        />
      ) : null}

      <section className="card">
        <h2>Turn Failure Report</h2>
        <ReportView report={report} />
        <p>
          <a href="/api/export" download="pacelab-trials.csv">
            Download all trials (CSV)
          </a>
        </p>
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
