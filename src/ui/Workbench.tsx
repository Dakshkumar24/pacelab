import { useEffect, useRef, useState } from "react";
import { EOT_THRESHOLD, type Mode, MODES } from "../config";
import { canEnd, canStart, type CallPhase, PHASE_LABEL } from "../lib/callMachine";
import { countedIn, PLAN_MODES, REPEATS } from "../lib/experiment";
import { scenarioById, SCENARIOS } from "../lib/scenarios";
import { MOCK_CAPTURE, MOCK_LIVE, MOCK_SCENARIO, mockKind } from "./devMock";
import { FailureCard, LabelForm, MODE_NAME, ScriptGuide, summarize, Tag } from "./parts";
import type { LabData } from "./useLabData";
import { type Capture, useCall } from "./useCall";
import { MicMeter } from "./visuals";

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function ms(v: number | undefined): string {
  return v === undefined ? "—" : `${v} ms`;
}

/** What the session is doing right now, from real call state only. */
function signal(phase: CallPhase, level: number, silenceSince: number | null) {
  if (phase === "responding") return 3;
  if (phase !== "listening") return -1;
  if (level >= 0.04) return 1;
  if (silenceSince !== null) return 2;
  return 0;
}

const SIGNALS = ["Listening", "You're speaking", "Pause held", "Agent replying"];

export function Workbench({
  lab,
  onExpired,
  goResults
}: {
  lab: LabData;
  onExpired: () => void;
  goResults: () => void;
}) {
  const { trials, usage, report, refresh, loadError } = lab;
  const mock = import.meta.env.DEV ? mockKind() : null;
  const [mode, setMode] = useState<Mode>("standard");
  const [scenarioId, setScenarioId] = useState(() => (mock ? MOCK_SCENARIO : 1));
  const [autoEnd, setAutoEnd] = useState(true);
  const [pending, setPending] = useState<Capture | null>(() => (mock === "label" ? MOCK_CAPTURE : null));
  const [toast, setToast] = useState<string | null>(null);
  const [correction, setCorrection] = useState("");
  const [followPlan, setFollowPlan] = useState(!mock);
  const labelRef = useRef<HTMLDivElement>(null);

  const real = useCall({
    autoEnd,
    onSessionExpired: onExpired,
    onSettled: (capture) => {
      setPending(capture);
      // The agent reports the call's fate a moment after the socket closes.
      setTimeout(() => void refresh(), 800);
    }
  });
  const call = mock === "live" ? { ...real, ...MOCK_LIVE, live: true, state: { ...real.state, phase: MOCK_LIVE.phase } } : real;

  const next = report.progress.next;

  // Follow the planned order until the person picks something else.
  useEffect(() => {
    if (followPlan && next && !pending && canStart(call.state)) {
      setMode(next.mode);
      setScenarioId(next.scenario);
    }
  }, [followPlan, next, pending, call.state]);

  // Bring the labeling panel into view when a call ends.
  useEffect(() => {
    if (pending && !mock) labelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [pending, mock]);

  const scenario = scenarioById(scenarioId) ?? SCENARIOS[0];
  const phase = call.state.phase;
  const busy = !canStart(call.state) && mock !== "live";
  const locked = busy || !!pending;
  const onPlan = next?.scenario === scenarioId && next.mode === mode;
  const callsLeft = usage ? usage.cap - usage.used : null;
  const active = signal(phase, call.audioLevel, call.silenceSince);
  const lines = call.lines.length ? call.lines : (pending?.lines ?? []);
  const timings = pending ? summarize(pending).turn : undefined;
  const progressPct = Math.round((report.progress.valid / report.progress.planned) * 100);

  function done(message: string) {
    setPending(null);
    setToast(message);
    setFollowPlan(true);
    real.reset();
    void refresh();
  }

  function dismiss() {
    setPending(null);
    real.reset();
  }

  const showFailure = pending && summarize(pending).userTranscripts.join("").trim() === "";

  return (
    <div className="container page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Workbench</p>
          <h1 className="h-page">Run a trial</h1>
        </div>
        <dl className="mini-stats">
          <div>
            <dt>Counted</dt>
            <dd>
              {report.progress.valid}
              <small>/{report.progress.planned}</small>
            </dd>
          </div>
          <div>
            <dt>Calls left today</dt>
            <dd>
              {callsLeft ?? "–"}
              <small>/{usage?.cap ?? 30}</small>
            </dd>
          </div>
          <div>
            <dt>
              Neurons used <Tag kind={"≈"} />
            </dt>
            <dd>
              {usage ? `${Math.round(usage.estimatedNeurons / 100) / 10}k` : "–"}
              <small>/10k</small>
            </dd>
          </div>
          <div>
            <dt>Technical failures</dt>
            <dd>{report.progress.technicalFailures}</dd>
          </div>
        </dl>
      </header>

      {mock ? (
        <div className="banner banner-mock" role="note">
          <span>
            <strong>Mocked {mock === "live" ? "live session" : "finished call"}.</strong> Development
            preview with invented data: no microphone, no model, nothing is saved.
          </span>
        </div>
      ) : null}
      {usage?.providerExhausted ? (
        <div className="banner banner-warn" role="status">
          <strong>Workers AI's free allocation for today is used up.</strong> Calls will fail to
          start until it resets at {clockTime(usage.resetsAt)} your time (00:00 UTC). Failed starts
          do not use call slots.
        </div>
      ) : null}
      {toast ? (
        <div className="banner banner-ok" role="status">
          <span>{toast}</span>
          <span className="banner-actions">
            <button type="button" className="link" onClick={goResults}>
              View results
            </button>
            <button type="button" className="link" onClick={() => setToast(null)}>
              Dismiss
            </button>
          </span>
        </div>
      ) : null}
      {loadError ? (
        <div className="banner banner-warn" role="alert">
          {loadError}
        </div>
      ) : null}

      <div className="bench">
        <section className="panel config" aria-labelledby="config-heading">
          <h2 id="config-heading" className="panel-title">
            Configuration
          </h2>

          <div className="next-card">
            <div className="next-top">
              <span className="eyebrow">{report.progress.complete ? "Plan complete" : "Recommended next"}</span>
              <span className="next-count">
                {report.progress.valid} of {report.progress.planned}
              </span>
            </div>
            <p className="next-title">
              {report.progress.complete
                ? "All 24 planned trials are in."
                : next
                  ? `Scenario ${next.scenario} · ${MODE_NAME[next.mode]} · run ${next.repeat}`
                  : "—"}
            </p>
            <div className="progress" role="progressbar" aria-label="Planned trials counted" aria-valuemin={0} aria-valuemax={report.progress.planned} aria-valuenow={report.progress.valid}>
              <span style={{ width: `${progressPct}%` }} />
            </div>
            {next ? (
              onPlan ? (
                <p className="fine">
                  Recommended next: scenario {next.scenario} in {MODE_NAME[next.mode]} mode, run {next.repeat}. The order alternates which mode goes first.
                </p>
              ) : (
                <button type="button" className="btn btn-quiet btn-sm" disabled={locked} onClick={() => setFollowPlan(true)}>
                  Back to the recommended trial
                </button>
              )
            ) : null}
          </div>

          <fieldset className="field">
            <legend>Mode</legend>
            <div className="mode-switch" role="radiogroup" aria-label="Turn-taking mode">
              {MODES.map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={mode === m}
                  className={mode === m ? `mode-opt on ${m}` : `mode-opt ${m}`}
                  disabled={locked}
                  onClick={() => {
                    setFollowPlan(false);
                    setMode(m);
                  }}
                >
                  <span className="mode-name">{MODE_NAME[m]}</span>
                  <span className="mode-sub">
                    <code>eotThreshold {EOT_THRESHOLD[m].toFixed(2)}</code>
                  </span>
                  <span className="mode-desc">{m === "standard" ? "Ends the turn sooner" : "Waits for more certainty"}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="field">
            <legend>Scenario</legend>
            <div className="scenario-list" role="radiogroup" aria-label="Scenario">
              {SCENARIOS.map((s) => {
                const isNext = next?.scenario === s.id && next.mode === mode;
                return (
                  <label key={s.id} className={scenarioId === s.id ? "scenario on" : "scenario"}>
                    <input
                      type="radio"
                      name="scenario"
                      checked={scenarioId === s.id}
                      disabled={locked}
                      onChange={() => {
                        setFollowPlan(false);
                        setScenarioId(s.id);
                      }}
                    />
                    <span className="scenario-n">{s.id}</span>
                    <span className="scenario-text">
                      <span className="scenario-name">
                        {s.name}
                        {isNext ? <span className="pill-next">next</span> : null}
                      </span>
                      <span className="scenario-tests">{s.tests}</span>
                    </span>
                    <span className="scenario-dots" aria-label={PLAN_MODES.map((m) => `${MODE_NAME[m]} ${Math.min(countedIn(trials ?? [], s.id, m), REPEATS)} of ${REPEATS}`).join(", ")}>
                      {PLAN_MODES.map((m) => (
                        <span className={`dots ${m}`} key={m}>
                          {Array.from({ length: REPEATS }, (_, i) => (
                            <i key={i} className={i < countedIn(trials ?? [], s.id, m) ? "filled" : ""} />
                          ))}
                        </span>
                      ))}
                    </span>
                  </label>
                );
              })}
            </div>
            <p className="legend-line">
              <span className="dots standard"><i className="filled" /></span> Standard runs
              <span className="dots patient"><i className="filled" /></span> Patient runs
            </p>
          </fieldset>

          <div className="script-block" key={`${scenarioId}-${mode}`}>
            <div className="script-head">
              <h3>Read aloud</h3>
              <span className="fine">Hold each pause until its bar fills</span>
            </div>
            <ScriptGuide scenario={scenario} silenceSince={call.silenceSince} pausesHeld={call.pausesHeld} live={call.live} />
            <p className="fine">
              <strong>Looking for:</strong> {scenario.intent} The timer is silent; your real pauses are measured approximately.
            </p>
          </div>
        </section>

        <section className="panel session" aria-labelledby="session-heading">
          <div className="session-head">
            <h2 id="session-heading" className="panel-title">
              Live session
            </h2>
            <span className={`phase-pill phase-${phase}`} aria-live="polite">
              <span className="phase-dot" aria-hidden="true" />
              {PHASE_LABEL[phase]}
            </span>
          </div>

          <div className={call.live ? "mic-card live" : "mic-card"}>
            <div className="mic-info">
              <span className="mic-label">Microphone</span>
              <span className="mic-state">
                {call.live ? "On · streaming to the agent" : phase === "checking_mic" ? "Requesting access…" : "Off"}
              </span>
            </div>
            <MicMeter level={call.audioLevel} live={call.live} />
          </div>

          <ol className="signal" aria-label="Session signal">
            {SIGNALS.map((s, i) => (
              <li key={s} className={active === i ? "on" : ""} aria-current={active === i ? "step" : undefined}>
                {s}
              </li>
            ))}
          </ol>

          {/* On narrow screens the script panel is far above; repeat it next to the controls. */}
          <div className="script-inline" aria-hidden="true">
            <ScriptGuide scenario={scenario} silenceSince={call.silenceSince} pausesHeld={call.pausesHeld} live={call.live} />
          </div>

          <div className="controls">
            <button
              type="button"
              className="btn btn-accent"
              onClick={() => void real.start(mode, scenarioId)}
              disabled={busy || !!pending || mock === "live"}
            >
              Start call
            </button>
            <button type="button" className="btn btn-secondary" onClick={real.end} disabled={!canEnd(real.state)}>
              {phase === "checking_mic" || phase === "connecting" ? "Cancel" : "End call"}
            </button>
            <button type="button" className="btn btn-quiet" onClick={real.cutOff} disabled={!call.live || mock === "live"}>
              Cut me off{call.cutOffs ? ` (${call.cutOffs})` : ""}
            </button>
          </div>
          <label className="check">
            <input type="checkbox" checked={autoEnd} disabled={busy} onChange={(e) => setAutoEnd(e.target.checked)} />
            End the call automatically after the first reply (saves Workers AI allocation)
          </label>
          {pending && !busy ? <p className="fine">Label or dismiss the last call before starting another.</p> : null}

          <div className="transcript-wrap">
            <h3 className="sub-title">
              Transcript <Tag kind="SDK" />
            </h3>
            <ul className="transcript" aria-live="polite">
              {lines.map((l, i) => (
                <li key={i} className={l.role}>
                  <span className="who">{l.role === "user" ? "You" : "Agent"}</span>
                  <span className="said">{l.text}</span>
                </li>
              ))}
              {call.interim ? (
                <li className="user interim">
                  <span className="who">You</span>
                  <span className="said">{call.interim}…</span>
                </li>
              ) : null}
              {!lines.length && !call.interim ? (
                <li className="empty">
                  {call.live
                    ? "Listening. Each line here is a turn the SDK committed."
                    : "Committed turns and the agent's reply appear here during a call."}
                </li>
              ) : null}
            </ul>
          </div>

          {call.live ? (
            <details className="disclose">
              <summary>Send a typed correction</summary>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!correction.trim()) return;
                  real.sendCorrection(correction.trim());
                  setCorrection("");
                }}
              >
                <label className="sr-only" htmlFor="correction">
                  Typed correction
                </label>
                <input
                  id="correction"
                  value={correction}
                  placeholder="Bypasses speech recognition; marks the trial as repaired"
                  onChange={(e) => setCorrection(e.target.value)}
                />
                <button type="submit" className="btn btn-secondary btn-sm" disabled={!correction.trim()}>
                  Send
                </button>
              </form>
            </details>
          ) : null}

          <div className="timings">
            <h3 className="sub-title">
              SDK timings <Tag kind="SDK" />
            </h3>
            {timings ? (
              <dl>
                <div>
                  <dt>Final transcript → first audio</dt>
                  <dd>{ms(timings.finalInputToFirstAudioMs)}</dd>
                </div>
                <div>
                  <dt>Model → first text</dt>
                  <dd>{ms(timings.modelToFirstTextMs)}</dd>
                </div>
                <div>
                  <dt>TTS → first audio</dt>
                  <dd>{ms(timings.ttsToFirstAudioMs)}</dd>
                </div>
                <div>
                  <dt>Speech start → final transcript</dt>
                  <dd>{ms(timings.speechStartToFinalMs)}</dd>
                </div>
              </dl>
            ) : (
              <p className="fine">Server-clock timings for the answered turn appear here when the call ends.</p>
            )}
          </div>
        </section>
      </div>

      <div ref={labelRef} className="label-zone">
        {pending && !busy ? (
          showFailure ? (
            <FailureCard key={pending.name} capture={pending} onSaved={done} onDismiss={dismiss} onExpired={onExpired} />
          ) : (
            <LabelForm
              key={pending.name}
              capture={pending}
              scenario={scenarioById(pending.scenario) ?? SCENARIOS[0]}
              trials={trials ?? []}
              onSaved={mock ? () => dismiss() : done}
              onDiscard={dismiss}
              onExpired={onExpired}
            />
          )
        ) : null}
      </div>
    </div>
  );
}
