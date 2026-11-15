import { useCallback, useEffect, useMemo, useState } from "react";
import { EOT_THRESHOLD, type Mode, MODES } from "../config";
import { canEnd, canStart, PHASE_LABEL } from "../lib/callMachine";
import type { Slot } from "../lib/experiment";
import type { Usage } from "../lib/quota";
import { buildReport } from "../lib/report";
import { scenarioById, SCENARIOS } from "../lib/scenarios";
import type { Trial } from "../lib/trial";
import { Matrix, ReportView } from "./Report";
import { FailureCard, LabelForm, MODE_NAME, ScriptGuide, summarize, Tag } from "./parts";
import { type Capture, useCall } from "./useCall";

function clockTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function Workbench({ onExpired }: { onExpired: () => void }) {
  const [mode, setMode] = useState<Mode>("standard");
  const [scenarioId, setScenarioId] = useState(1);
  const [autoEnd, setAutoEnd] = useState(true);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [trials, setTrials] = useState<Trial[] | null>(null);
  const [pending, setPending] = useState<Capture | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [correction, setCorrection] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [followPlan, setFollowPlan] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const [u, t] = await Promise.all([fetch("/api/usage"), fetch("/api/trials")]);
      if (u.status === 401 || t.status === 401) return onExpired();
      if (!u.ok || !t.ok) throw new Error();
      setUsage((await u.json()) as Usage);
      setTrials(((await t.json()) as { trials: Trial[] }).trials);
      setLoadError(null);
    } catch {
      setLoadError("Could not load saved trials. Check your connection and reload.");
    }
  }, [onExpired]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const call = useCall({
    autoEnd,
    onSessionExpired: onExpired,
    onSettled: (capture) => {
      setPending(capture);
      // The agent reports the call's fate a moment after the socket closes.
      setTimeout(() => void refresh(), 800);
    }
  });

  // The report is computed from the same trials the page lists, with the same code the server uses.
  const report = useMemo(() => buildReport(trials ?? []), [trials]);
  const next = report.progress.next;

  // Follow the planned order until the person picks something else.
  useEffect(() => {
    if (followPlan && next && !pending && canStart(call.state)) {
      setMode(next.mode);
      setScenarioId(next.scenario);
    }
  }, [followPlan, next, pending, call.state]);

  const scenario = scenarioById(scenarioId) ?? SCENARIOS[0];
  const phase = call.state.phase;
  const busy = !canStart(call.state);
  const onPlan = next?.scenario === scenarioId && next.mode === mode;
  const callsLeft = usage ? usage.cap - usage.used : null;

  function pick(slot: Slot) {
    if (busy || pending) return;
    setFollowPlan(false);
    setMode(slot.mode);
    setScenarioId(slot.scenario);
  }

  function done(message: string) {
    setPending(null);
    setToast(message);
    setFollowPlan(true);
    call.reset();
    void refresh();
  }

  function dismiss() {
    setPending(null);
    call.reset();
  }

  async function exclude(trial: Trial) {
    const reason = window.prompt("Why should this trial be excluded? (a few words)");
    if (!reason) return;
    const res = await fetch("/api/trial-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: trial.id, status: "excluded", statusReason: reason })
    });
    if (res.status === 401) return onExpired();
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    setToast(res.ok ? "Trial excluded. Its planned run is open again." : (data.error ?? "Could not exclude the trial."));
    void refresh();
  }

  async function deleteAll() {
    const res = await fetch("/api/trials", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ confirm: confirmText })
    });
    if (res.status === 401) return onExpired();
    const data = (await res.json().catch(() => ({}))) as { error?: string; archived?: number };
    setToast(res.ok ? `${data.archived} trials removed from the report and archived.` : (data.error ?? "Delete failed."));
    setConfirmText("");
    void refresh();
  }

  const showFailure =
    pending && (summarize(pending).userTranscripts.join("").trim() === "");
  const deletePhrase = `DELETE ${trials?.length ?? 0} TRIALS`;

  return (
    <>
      {usage?.providerExhausted ? (
        <div className="banner warn" role="status">
          <strong>Workers AI's free allocation for today is used up.</strong> Calls will fail to
          start until it resets at {clockTime(usage.resetsAt)} your time (00:00 UTC). Failed starts
          do not use call slots.
        </div>
      ) : null}
      {toast ? (
        <div className="banner ok" role="status">
          {toast}{" "}
          <button type="button" className="link" onClick={() => setToast(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {loadError ? <div className="banner warn" role="alert">{loadError}</div> : null}

      <section className="card" aria-labelledby="overview-heading">
        <h2 id="overview-heading">Experiment</h2>
        <div className="stats">
          <div>
            <b>
              {report.progress.valid}/{report.progress.planned}
            </b>
            <span>planned trials counted</span>
          </div>
          <div>
            <b>{callsLeft ?? "–"}</b>
            <span>calls left today (cap {usage?.cap ?? 30})</span>
          </div>
          <div>
            <b>
              {usage ? `${Math.round(usage.estimatedNeurons / 100) / 10}k` : "–"}
              <small>/10k</small>
            </b>
            <span>
              neurons used, estimate <Tag kind={"≈"} />
            </span>
          </div>
          <div>
            <b>{report.progress.technicalFailures}</b>
            <span>
              technical failures · {report.progress.excluded} excluded ·{" "}
              {report.progress.exploratory} exploratory
            </span>
          </div>
        </div>
        <Matrix report={report} onPick={pick} />
        <p className="muted">
          {report.progress.complete
            ? "All 24 planned trials are in."
            : next
              ? `Recommended next: scenario ${next.scenario} in ${MODE_NAME[next.mode]} mode, run ${next.repeat}. The order alternates which mode goes first so neither always gets your first attempt.`
              : ""}{" "}
          The neuron figure is this app's estimate from call length and reply length; Cloudflare's
          usage page is the authority.
        </p>
      </section>

      <div className="bench">
        <section className="card" aria-labelledby="configure-heading">
          <h2 id="configure-heading">
            <span className="step">1</span> Configure
          </h2>
          <div className="modes" role="radiogroup" aria-label="Turn-taking mode">
            {MODES.map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className={mode === m ? "mode on" : "mode"}
                disabled={busy || !!pending}
                onClick={() => {
                  setFollowPlan(false);
                  setMode(m);
                }}
              >
                <span className="mode-name">{MODE_NAME[m]}</span>
                <span className="mode-sub">eotThreshold {EOT_THRESHOLD[m]}</span>
                <span className="mode-desc">
                  {m === "standard" ? "Ends the turn sooner" : "Waits for more certainty"}
                </span>
              </button>
            ))}
          </div>
          <label htmlFor="scenario">Scenario</label>
          <select
            id="scenario"
            value={scenarioId}
            disabled={busy || !!pending}
            onChange={(e) => {
              setFollowPlan(false);
              setScenarioId(Number(e.target.value));
            }}
          >
            {SCENARIOS.map((s) => (
              <option key={s.id} value={s.id}>
                {s.id}. {s.name} ({s.tests})
              </option>
            ))}
          </select>
          <p className="muted">
            {scenario.intent} The threshold is the only difference between modes: same prompt, model,
            voice and script.
          </p>
          {!onPlan && next ? (
            <button
              type="button"
              className="ghost"
              disabled={busy || !!pending}
              onClick={() => setFollowPlan(true)}
            >
              Back to the recommended trial
            </button>
          ) : null}
        </section>

        <section className="card" aria-labelledby="speak-heading">
          <h2 id="speak-heading">
            <span className="step">2</span> Speak
          </h2>
          <p className="muted">
            Press Start, wait for "Listening", then read this aloud. Hold each pause until its bar
            fills. The timer is silent and your real pause length is approximate.
          </p>
          <ScriptGuide
            scenario={scenario}
            silenceSince={call.silenceSince}
            pausesHeld={call.pausesHeld}
            live={call.live}
          />
          <div className="row">
            <button
              type="button"
              className="primary"
              onClick={() => void call.start(mode, scenarioId)}
              disabled={busy || !!pending}
            >
              Start call
            </button>
            <button type="button" onClick={call.end} disabled={!canEnd(call.state)}>
              {phase === "checking_mic" || phase === "connecting" ? "Cancel" : "End call"}
            </button>
            <button type="button" onClick={call.cutOff} disabled={!call.live}>
              Cut me off{call.cutOffs ? ` (${call.cutOffs})` : ""}
            </button>
          </div>
          <p className={`status phase-${phase}`} aria-live="polite">
            <span className="status-dot" />
            {PHASE_LABEL[phase]}
            {call.live ? (
              <span className="meter" aria-hidden="true">
                <span style={{ width: `${Math.min(100, call.audioLevel * 400)}%` }} />
              </span>
            ) : null}
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={autoEnd}
              disabled={busy}
              onChange={(e) => setAutoEnd(e.target.checked)}
            />
            End the call automatically after the first reply (saves Workers AI allocation)
          </label>
          {pending && !busy ? (
            <p className="muted">Label or dismiss the last call before starting another.</p>
          ) : null}
        </section>
      </div>

      <section className="card" aria-labelledby="observe-heading">
        <h2 id="observe-heading">
          <span className="step">3</span> Observe
        </h2>
        <ul className="transcript" aria-live="polite">
          {(call.lines.length ? call.lines : (pending?.lines ?? [])).map((l, i) => (
            <li key={i} className={l.role}>
              <span className="who">{l.role === "user" ? "You" : "Agent"}</span>
              <span>{l.text}</span>
            </li>
          ))}
          {call.interim ? (
            <li className="user interim">
              <span className="who">You</span>
              <span>{call.interim}…</span>
            </li>
          ) : null}
          {!call.lines.length && !pending?.lines.length && !call.interim ? (
            <li className="empty">
              {call.live
                ? "Listening. Each line here is a turn the SDK committed."
                : "Committed turns and the agent's reply appear here during a call."}
            </li>
          ) : null}
        </ul>
        {call.live ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              if (!correction.trim()) return;
              call.sendCorrection(correction.trim());
              setCorrection("");
            }}
          >
            <label className="sr-only" htmlFor="correction">
              Typed correction
            </label>
            <input
              id="correction"
              value={correction}
              placeholder="Typed correction (bypasses speech recognition; marks the trial as repaired)"
              onChange={(e) => setCorrection(e.target.value)}
            />
            <button type="submit" disabled={!correction.trim()}>
              Send
            </button>
          </form>
        ) : null}
      </section>

      {pending && !busy ? (
        showFailure ? (
          <FailureCard
            key={pending.name}
            capture={pending}
            onSaved={done}
            onDismiss={dismiss}
            onExpired={onExpired}
          />
        ) : (
          <LabelForm
            key={pending.name}
            capture={pending}
            scenario={scenarioById(pending.scenario) ?? SCENARIOS[0]}
            trials={trials ?? []}
            onSaved={done}
            onDiscard={dismiss}
            onExpired={onExpired}
          />
        )
      ) : null}

      <ReportView report={report} trials={trials ?? []} onExclude={exclude} />

      <section className="card danger" aria-labelledby="danger-heading">
        <h2 id="danger-heading">Remove all trials</h2>
        <p className="muted">
          Download the CSV first. This clears the report. The rows are moved to an archive table in
          the Durable Object rather than destroyed, but the app has no restore button. To exclude one
          bad trial, open it in the list above instead.
        </p>
        <label htmlFor="confirm">
          Type <code>{deletePhrase}</code> to confirm
        </label>
        <div className="row">
          <input
            id="confirm"
            value={confirmText}
            autoComplete="off"
            onChange={(e) => setConfirmText(e.target.value)}
          />
          <button
            type="button"
            className="destructive"
            disabled={confirmText !== deletePhrase || !trials?.length}
            onClick={() => void deleteAll()}
          >
            Remove all trials
          </button>
        </div>
      </section>
    </>
  );
}
