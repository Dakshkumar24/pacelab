import { useState } from "react";
import { type Report } from "../lib/report";
import { type Trial, trialsToCsv } from "../lib/trial";
import { DecisionCard, FullComparison, Glossary, HeadlineStats, Matrix, ScenarioChart, TrialList } from "./Report";

/** Download for the synthetic demo, built in the browser. Real data comes from /api/export. */
function downloadCsv(trials: Trial[]) {
  const url = URL.createObjectURL(new Blob([trialsToCsv(trials)], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = "pacelab-demo-trials.csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The Turn Failure Report: shared by Results (real trials) and the Demo (synthetic ones). */
export function ResultsBody({
  report,
  trials,
  demo,
  onExclude
}: {
  report: Report;
  trials: Trial[];
  demo?: boolean;
  onExclude?: (t: Trial, reason: string) => Promise<void>;
}) {
  const p = report.progress;
  return (
    <>
      <DecisionCard report={report} />

      <section className="block" aria-labelledby="compare-head">
        <div className="block-head">
          <h2 id="compare-head" className="h-block">
            Standard vs Patient
          </h2>
          <p className="muted">
            Counted trials only. Unknown judgments are shown but never enter a rate.
          </p>
        </div>
        <HeadlineStats report={report} />
      </section>

      <section className="block two-col" aria-label="Scenario breakdown and plan">
        <div>
          <div className="block-head">
            <h2 className="h-block">Where it fails</h2>
          </div>
          <ScenarioChart report={report} />
        </div>
        <div>
          <div className="block-head">
            <h2 className="h-block">Trial plan</h2>
            <p className="muted">
              {p.valid} of {p.planned} counted · {p.technicalFailures} technical{" "}
              {p.technicalFailures === 1 ? "failure" : "failures"} · {p.excluded} excluded · {p.exploratory} exploratory
            </p>
          </div>
          <Matrix report={report} />
        </div>
      </section>

      <section className="block" aria-labelledby="full-head">
        <details className="disclose disclose-card">
          <summary>
            <span id="full-head" className="h-block">
              Every measure
            </span>
            <span className="muted">SDK timings, splits, per-scenario detail</span>
          </summary>
          <FullComparison report={report} />
        </details>
      </section>

      <section className="block" aria-labelledby="trials-head">
        <div className="block-head block-head-row">
          <div>
            <h2 id="trials-head" className="h-block">
              Trial evidence
            </h2>
            <p className="muted">Transcripts, replies, labels, notes and event timelines.</p>
          </div>
          {demo ? (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => downloadCsv(trials)}>
              Download demo CSV
            </button>
          ) : (
            <a className="btn btn-secondary btn-sm" href="/api/export" download>
              Export CSV
            </a>
          )}
        </div>
        <TrialList trials={trials} onExclude={onExclude} />
      </section>

      <section className="block" aria-labelledby="glossary-head">
        <details className="disclose disclose-card">
          <summary>
            <span id="glossary-head" className="h-block">
              What each measure can and cannot show
            </span>
            <span className="muted">
              <abbr title="SDK measurement">SDK</abbr> · <abbr title="Manual judgment">M</abbr> · <abbr title="Browser estimate">≈</abbr>
            </span>
          </summary>
          <Glossary />
        </details>
      </section>
    </>
  );
}

export function Results({
  report,
  trials,
  loadError,
  onExpired,
  refresh,
  goWorkbench
}: {
  report: Report;
  trials: Trial[] | null;
  loadError: string | null;
  onExpired: () => void;
  refresh: () => Promise<void>;
  goWorkbench: () => void;
}) {
  const [toast, setToast] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState("");
  const list = trials ?? [];

  async function exclude(trial: Trial, reason: string) {
    const res = await fetch("/api/trial-status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: trial.id, status: "excluded", statusReason: reason })
    });
    if (res.status === 401) return onExpired();
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    setToast(res.ok ? "Trial excluded. Its planned run is open again." : (data.error ?? "Could not exclude the trial."));
    await refresh();
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
    await refresh();
  }

  const deletePhrase = `DELETE ${list.length} TRIALS`;

  return (
    <div className="container page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Results</p>
          <h1 className="h-page">Turn Failure Report</h1>
        </div>
        <button type="button" className="btn btn-accent" onClick={goWorkbench}>
          {report.progress.complete ? "Run an exploratory trial" : "Run the next trial"}
        </button>
      </header>
      {toast ? (
        <div className="banner banner-ok" role="status">
          <span>{toast}</span>
          <button type="button" className="link" onClick={() => setToast(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      {loadError ? (
        <div className="banner banner-warn" role="alert">
          {loadError}
        </div>
      ) : null}
      {trials === null && !loadError ? <p className="muted">Loading saved trials…</p> : null}
      {trials !== null && report.progress.valid === 0 ? (
        <div className="empty-state">
          <h2 className="h-block">No counted trials yet.</h2>
          <p className="muted">Run the first recommended trial in the Workbench. The report fills in as you label calls.</p>
        </div>
      ) : null}

      <ResultsBody report={report} trials={list} onExclude={exclude} />

      <section className="block">
        <details className="disclose disclose-card danger">
          <summary>
            <span className="h-block">Remove all trials</span>
            <span className="muted">Archives every row and clears the report</span>
          </summary>
          <p className="muted">
            Export the CSV first. This clears the report. The rows are moved to an archive table in
            the Durable Object rather than destroyed, but the app has no restore button. To exclude
            one bad trial, open it in the evidence list instead.
          </p>
          <label htmlFor="confirm">
            Type <code>{deletePhrase}</code> to confirm
          </label>
          <div className="row">
            <input id="confirm" value={confirmText} autoComplete="off" onChange={(e) => setConfirmText(e.target.value)} />
            <button
              type="button"
              className="btn btn-danger"
              disabled={confirmText !== deletePhrase || !list.length}
              onClick={() => void deleteAll()}
            >
              Remove all trials
            </button>
          </div>
        </details>
      </section>
    </div>
  );
}
