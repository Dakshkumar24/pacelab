import { useState } from "react";
import { EOT_THRESHOLD, type Mode } from "../config";
import { PLAN_MODES, REPEATS, type Slot } from "../lib/experiment";
import { type ModeCell, percent, type Rate, type Report, type Spread } from "../lib/report";
import { scenarioById } from "../lib/scenarios";
import type { Trial } from "../lib/trial";
import { MODE_NAME, Tag, Timeline } from "./parts";

function rateText(r: Rate): string {
  if (r.judged === 0) return r.unknown ? `no judgment (${r.unknown} unknown)` : "—";
  return `${r.yes}/${r.judged} (${percent(r)}%)${r.unknown ? ` · ${r.unknown} unknown` : ""}`;
}

function spreadText(s: Spread): string {
  if (s.n === 0 || s.median === null) return "—";
  return s.n === 1 ? `${s.median} ms (n=1)` : `${s.median} ms (${s.min}–${s.max}, n=${s.n})`;
}

type Row = { label: string; tag?: "SDK" | "M" | "≈"; get: (c: ModeCell) => string };

const ROWS: Row[] = [
  { label: "Counted trials", get: (c) => `${c.trials}` },
  { label: "Premature response", tag: "M", get: (c) => rateText(c.premature) },
  { label: "Transcription correct", tag: "M", get: (c) => rateText(c.transcriptionCorrect) },
  { label: "Response appropriate", tag: "M", get: (c) => rateText(c.responseAppropriate) },
  { label: "Reply cancelled or cut short", tag: "M", get: (c) => rateText(c.replyCutShort) },
  { label: "Turn succeeded (all three good)", tag: "M", get: (c) => rateText(c.succeeded) },
  { label: "Request split into several turns", tag: "SDK", get: (c) => `${c.sdkSplits}/${c.trials}` },
  { label: "Reply turn not completed", tag: "SDK", get: (c) => `${c.sdkReplyNotCompleted}/${c.trials}` },
  { label: "Final transcript → first audio", tag: "SDK", get: (c) => spreadText(c.finalInputToFirstAudio) },
  { label: " Model → first text", tag: "SDK", get: (c) => spreadText(c.modelToFirstText) },
  { label: " TTS → first audio", tag: "SDK", get: (c) => spreadText(c.ttsToFirstAudio) },
  { label: "Speech start → final transcript", tag: "SDK", get: (c) => spreadText(c.speechStartToFinal) },
  { label: "Perceived wait", tag: "≈", get: (c) => spreadText(c.perceivedWait) },
  { label: "Technical failures (not counted)", get: (c) => `${c.technicalFailures}` },
  { label: "Excluded / exploratory (not counted)", get: (c) => `${c.excluded} / ${c.exploratory}` }
];

function Comparison({ caption, standard, patient }: { caption: string; standard: ModeCell; patient: ModeCell }) {
  return (
    <div className="table-wrap">
      <table className="compare">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Measure</th>
            <th scope="col">Standard ({EOT_THRESHOLD.standard})</th>
            <th scope="col">Patient ({EOT_THRESHOLD.patient})</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map((r) => (
            <tr key={r.label}>
              <th scope="row">
                {r.label} {r.tag ? <Tag kind={r.tag} /> : null}
              </th>
              <td>{r.get(standard)}</td>
              <td>{r.get(patient)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 6 x 2 grid of planned runs. A filled dot is a counted trial. */
export function Matrix({
  report,
  onPick
}: {
  report: Report;
  onPick?: (slot: Slot) => void;
}) {
  const { progress } = report;
  return (
    <div className="matrix" role="table" aria-label="Planned trials">
      <div className="matrix-row matrix-head" role="row">
        <span role="columnheader">Scenario</span>
        {PLAN_MODES.map((m) => (
          <span role="columnheader" key={m}>
            {MODE_NAME[m]}
          </span>
        ))}
      </div>
      {report.scenarios.map((row) => (
        <div className="matrix-row" role="row" key={row.scenario}>
          <span role="rowheader">
            {row.scenario}. {scenarioById(row.scenario)?.name}
          </span>
          {PLAN_MODES.map((mode) => {
            const cell = progress.cells.find((c) => c.scenario === row.scenario && c.mode === mode)!;
            const isNext = progress.next?.scenario === row.scenario && progress.next.mode === mode;
            const label = `${Math.min(cell.counted, REPEATS)} of ${REPEATS} runs done`;
            const dots = Array.from({ length: REPEATS }, (_, i) => (
              <span key={i} className={i < cell.counted ? "dot filled" : "dot"} />
            ));
            return onPick ? (
              <button
                type="button"
                role="cell"
                key={mode}
                className={isNext ? "cell next" : "cell"}
                title={isNext ? `${label}. Recommended next.` : label}
                onClick={() => onPick({ scenario: row.scenario, mode, repeat: cell.counted + 1 })}
              >
                {dots}
                <span className="sr-only">{label}</span>
                {isNext ? <span className="next-mark">next</span> : null}
              </button>
            ) : (
              <span role="cell" key={mode} className="cell" title={label}>
                {dots}
                <span className="sr-only">{label}</span>
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** Premature-response rate per scenario, one bar per mode. The only chart: it is the question. */
function PrematureChart({ report }: { report: Report }) {
  return (
    <figure className="chart">
      <figcaption>
        Premature responses by scenario <Tag kind="M" />
        <span className="legend">
          <i className="swatch standard" /> Standard <i className="swatch patient" /> Patient
        </span>
      </figcaption>
      {report.scenarios.map((row) => (
        <div className="chart-row" key={row.scenario}>
          <span className="chart-label">
            {row.scenario}. {scenarioById(row.scenario)?.name}
          </span>
          <div className="bars">
            {(["standard", "patient"] as Mode[]).map((mode) => {
              const r = row[mode].premature;
              const pct = percent(r);
              return (
                <div className="bar-line" key={mode}>
                  <div className="bar-track">
                    <div className={`bar ${mode}`} style={{ width: `${pct ?? 0}%` }} />
                  </div>
                  <span className="bar-value">{pct === null ? "no data" : `${r.yes}/${r.judged}`}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </figure>
  );
}

export function DecisionCard({ report }: { report: Report }) {
  const d = report.decision;
  return (
    <div className={`decision ${d.verdict}`}>
      <p className="decision-head">{d.headline}</p>
      <dl>
        {d.points.map((p) => (
          <div key={p.label}>
            <dt>{p.label}</dt>
            <dd>{p.text}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

const GLOSSARY: { name: string; tag: "SDK" | "M" | "≈"; start: string; stop: string; shows: string; cannot: string }[] = [
  {
    name: "Speech start → final transcript",
    tag: "SDK",
    start: "Flux detects speech",
    stop: "Flux finalizes the transcript",
    shows: "How long the whole spoken turn took on the server clock.",
    cannot: "It includes your speaking time and every pause, so it is not latency. Shown for unsplit trials only."
  },
  {
    name: "Final transcript → first audio",
    tag: "SDK",
    start: "Transcript finalized",
    stop: "First speech audio leaves the server",
    shows: "Server-side time to start answering: model plus text-to-speech.",
    cannot: "It leaves out the end-of-turn wait before it, the network and browser playback after it. It does not depend on the threshold."
  },
  {
    name: "Model → first text",
    tag: "SDK",
    start: "Model is called",
    stop: "Model's first text arrives",
    shows: "The language model's start-up time, usually the largest part of the interval above.",
    cannot: "It varies run to run for reasons unrelated to turn-taking."
  },
  {
    name: "Perceived wait",
    tag: "≈",
    start: "Last moment the mic level was above the voice threshold",
    stop: "Browser starts playing the reply",
    shows: "Roughly what the speaker waited, end-of-turn wait included.",
    cannot: "Room noise or a quiet last word moves the start point. Compare modes with it; do not quote it as a latency."
  },
  {
    name: "Premature response and the other judgments",
    tag: "M",
    start: "—",
    stop: "—",
    shows: "What the person running the trial observed.",
    cannot: "One person, who knows the hypothesis, labels every trial. Rates use only trials judged yes or no."
  }
];

function TrialRow({ trial, onExclude }: { trial: Trial; onExclude?: (t: Trial) => void }) {
  return (
    <details className="trial">
      <summary>
        <span className={`chip ${trial.status}`}>{trial.status.replace("_", " ")}</span>
        <span>
          S{trial.scenario} · {MODE_NAME[trial.mode]}
          {trial.run ? ` · run ${trial.run}` : ""}
        </span>
        <span className="muted trial-text">
          {trial.userTranscripts.join(" | ") || trial.statusReason || "no speech"}
        </span>
      </summary>
      <dl className="evidence">
        <dt>Request <Tag kind="SDK" /></dt>
        <dd>{trial.userTranscripts.join(" | ") || "—"}</dd>
        <dt>Reply <Tag kind="SDK" /></dt>
        <dd>{trial.agentReply || "—"}</dd>
        <dt>Labels <Tag kind="M" /></dt>
        <dd>
          premature: {trial.labels.premature} · transcription correct:{" "}
          {trial.labels.transcriptionCorrect} · reply appropriate: {trial.labels.responseAppropriate}{" "}
          · cut short: {trial.labels.replyCutShort}
        </dd>
        {trial.statusReason ? (
          <>
            <dt>Reason</dt>
            <dd>{trial.statusReason}</dd>
          </>
        ) : null}
        {trial.notes ? (
          <>
            <dt>Notes</dt>
            <dd>{trial.notes}</dd>
          </>
        ) : null}
        <dt>Saved</dt>
        <dd>{new Date(trial.createdAt).toLocaleString()}</dd>
      </dl>
      {trial.events.length ? <Timeline events={trial.events} /> : null}
      {onExclude && (trial.status === "counted" || trial.status === "exploratory") ? (
        <button type="button" className="ghost" onClick={() => onExclude(trial)}>
          Exclude this trial…
        </button>
      ) : null}
    </details>
  );
}

export function ReportView({
  report,
  trials,
  onExclude,
  demo = false
}: {
  report: Report;
  trials: Trial[];
  onExclude?: (t: Trial) => void;
  demo?: boolean;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const { progress } = report;
  const empty = progress.valid === 0;
  return (
    <>
      <section className="card" aria-labelledby="report-heading">
        <h2 id="report-heading">Turn Failure Report</h2>
        <p className="muted">
          Standard and Patient on the same six scripts. {progress.valid} of {progress.planned}{" "}
          planned trials counted. Tags: <Tag kind="M" /> manual judgment, <Tag kind="SDK" /> SDK
          measurement on the server clock, <Tag kind={"≈"} /> browser estimate. Rates are
          yes / judged; "unknown" answers are listed, not counted.
        </p>
        {empty ? (
          <p className="empty">
            No counted trials yet. Run the recommended trial above, label it and save it as
            Counted. The comparison fills in as trials arrive.
          </p>
        ) : (
          <>
            <PrematureChart report={report} />
            <Comparison caption="All scenarios" standard={report.totals.standard} patient={report.totals.patient} />
            <div className="scenario-tabs" role="group" aria-label="Scenario detail">
              {report.scenarios.map((row) => (
                <button
                  type="button"
                  key={row.scenario}
                  className={open === row.scenario ? "tab on" : "tab"}
                  aria-pressed={open === row.scenario}
                  onClick={() => setOpen(open === row.scenario ? null : row.scenario)}
                >
                  Scenario {row.scenario}
                </button>
              ))}
            </div>
            {report.scenarios
              .filter((row) => row.scenario === open)
              .map((row) => (
                <div key={row.scenario}>
                  <Comparison
                    caption={`Scenario ${row.scenario}: ${scenarioById(row.scenario)?.name}`}
                    standard={row.standard}
                    patient={row.patient}
                  />
                  {[row.standard, row.patient].flatMap((c) =>
                    c.prematureExamples.map((ex) => (
                      <blockquote className="example" key={ex.id}>
                        <strong>{MODE_NAME[c.mode]}, labelled premature:</strong>{" "}
                        {ex.transcripts.map((t, i) => (
                          <span className="turn" key={i}>{t}</span>
                        ))}
                        <br />
                        Agent: {ex.reply || "no reply"}
                      </blockquote>
                    ))
                  )}
                </div>
              ))}
          </>
        )}
        <details>
          <summary>What each measurement means, and what it cannot tell you</summary>
          <div className="table-wrap">
            <table className="glossary">
              <thead>
                <tr>
                  <th scope="col">Measure</th>
                  <th scope="col">Timer starts</th>
                  <th scope="col">Timer stops</th>
                  <th scope="col">Shows</th>
                  <th scope="col">Cannot establish</th>
                </tr>
              </thead>
              <tbody>
                {GLOSSARY.map((g) => (
                  <tr key={g.name}>
                    <th scope="row">{g.name} <Tag kind={g.tag} /></th>
                    <td>{g.start}</td>
                    <td>{g.stop}</td>
                    <td>{g.shows}</td>
                    <td>{g.cannot}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section className="card" aria-labelledby="decision-heading">
        <h2 id="decision-heading">Decision summary</h2>
        <DecisionCard report={report} />
      </section>

      <section className="card" aria-labelledby="trials-heading">
        <h2 id="trials-heading">Saved trials ({trials.length})</h2>
        {trials.length === 0 ? (
          <p className="empty">Nothing saved yet.</p>
        ) : (
          [...trials].reverse().map((t) => <TrialRow key={t.id} trial={t} onExclude={onExclude} />)
        )}
        {demo ? null : (
          <p>
            <a href="/api/export" download="pacelab-trials.csv">
              Download all trials as CSV
            </a>
          </p>
        )}
      </section>
    </>
  );
}
