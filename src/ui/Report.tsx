import { useState } from "react";
import { EOT_THRESHOLD, type Mode } from "../config";
import { PLAN_MODES, REPEATS } from "../lib/experiment";
import { type ModeCell, percent, type Rate, type Report, type Spread } from "../lib/report";
import { scenarioById } from "../lib/scenarios";
import type { Trial, TrialStatus } from "../lib/trial";
import { MODE_NAME, Tag, Timeline } from "./parts";

type Kind = "SDK" | "M" | "≈";

export function rateText(r: Rate): string {
  if (r.judged === 0) return r.unknown ? `no judgment (${r.unknown} unknown)` : "—";
  return `${r.yes}/${r.judged} (${percent(r)}%)${r.unknown ? ` · ${r.unknown} unknown` : ""}`;
}

export function spreadText(s: Spread): string {
  if (s.n === 0 || s.median === null) return "—";
  return s.n === 1 ? `${s.median} ms (n=1)` : `${s.median} ms (${s.min}–${s.max}, n=${s.n})`;
}

/** The decision, as plainly as the data allows. */
export function DecisionCard({ report }: { report: Report }) {
  const d = report.decision;
  return (
    <section className={`decision decision-${d.verdict}`} aria-labelledby="decision-head">
      <p className="eyebrow">Decision summary</p>
      <h2 id="decision-head" className="decision-head">
        {d.headline}
      </h2>
      <dl className="decision-points">
        {d.points.map((p) => (
          <div key={p.label}>
            <dt>{p.label}</dt>
            <dd>{p.text}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** One measure, both modes, side by side. */
function StatPair({
  title,
  tag,
  standard,
  patient,
  bar,
  hint
}: {
  title: string;
  tag: Kind;
  standard: { main: string; sub: string; pct: number | null };
  patient: { main: string; sub: string; pct: number | null };
  bar: boolean;
  hint: string;
}) {
  return (
    <article className="stat">
      <header>
        <h3>{title}</h3>
        <Tag kind={tag} />
      </header>
      {(
        [
          ["standard", standard],
          ["patient", patient]
        ] as const
      ).map(([mode, v]) => (
        <div className="stat-row" key={mode}>
          <span className="stat-mode">
            <i className={`swatch ${mode}`} /> {MODE_NAME[mode]}
          </span>
          <span className="stat-main">{v.main}</span>
          <span className="stat-sub">{v.sub}</span>
          {bar ? (
            <span className="stat-track" aria-hidden="true">
              <span className={`stat-bar ${mode}`} style={{ width: `${v.pct ?? 0}%` }} />
            </span>
          ) : null}
        </div>
      ))}
      <p className="stat-hint">{hint}</p>
    </article>
  );
}

function rateView(r: Rate) {
  const p = percent(r);
  return {
    main: p === null ? "—" : `${p}%`,
    sub: r.judged ? `${r.yes} of ${r.judged}${r.unknown ? ` · ${r.unknown} unknown` : ""}` : "no judged trials",
    pct: p
  };
}

function spreadView(s: Spread) {
  return {
    main: s.median === null ? "—" : `${(s.median / 1000).toFixed(2)} s`,
    sub: s.n ? `median, n=${s.n}` : "no measurements",
    pct: null
  };
}

export function HeadlineStats({ report }: { report: Report }) {
  const { standard: s, patient: p } = report.totals;
  return (
    <div className="stats-grid">
      <StatPair
        title="Premature replies"
        tag="M"
        standard={rateView(s.premature)}
        patient={rateView(p.premature)}
        bar
        hint="Share of judged trials where the agent replied before the request was finished. Lower is better."
      />
      <StatPair
        title="Transcription correct"
        tag="M"
        standard={rateView(s.transcriptionCorrect)}
        patient={rateView(p.transcriptionCorrect)}
        bar
        hint="Intent and key details captured."
      />
      <StatPair
        title="Response appropriate"
        tag="M"
        standard={rateView(s.responseAppropriate)}
        patient={rateView(p.responseAppropriate)}
        bar
        hint="The reply fits the whole request."
      />
      <StatPair
        title="Perceived wait"
        tag={"≈"}
        standard={spreadView(s.perceivedWait)}
        patient={spreadView(p.perceivedWait)}
        bar={false}
        hint="Last word to first reply audio, estimated in the browser."
      />
    </div>
  );
}

/** Premature-reply rate per scenario. The one chart, because it is the question. */
export function ScenarioChart({ report }: { report: Report }) {
  return (
    <figure className="chart">
      <figcaption>
        <span>
          Premature replies by scenario <Tag kind="M" />
        </span>
        <span className="legend">
          <i className="swatch standard" /> Standard <i className="swatch patient" /> Patient
        </span>
      </figcaption>
      {report.scenarios.map((row) => (
        <div className="chart-row" key={row.scenario}>
          <span className="chart-label">
            <b>{row.scenario}</b> {scenarioById(row.scenario)?.name}
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
                  <span className="bar-value">{pct === null ? <span title="No judged trials">—</span> : `${r.yes}/${r.judged}`}</span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </figure>
  );
}

/** The 6 x 2 grid of planned runs. A filled dot is a counted trial. */
export function Matrix({ report, just }: { report: Report; just?: string | null }) {
  const { progress } = report;
  return (
    <div className="matrix" role="table" aria-label="Planned trials: two runs per scenario and mode">
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
            <b>{row.scenario}</b> {scenarioById(row.scenario)?.name}
          </span>
          {PLAN_MODES.map((mode) => {
            const cell = progress.cells.find((c) => c.scenario === row.scenario && c.mode === mode)!;
            const isNext = progress.next?.scenario === row.scenario && progress.next.mode === mode;
            const pop = just === `${row.scenario}-${mode}`;
            return (
              <span role="cell" key={mode} className={isNext ? "cell next" : "cell"}>
                {Array.from({ length: REPEATS }, (_, i) => (
                  <span
                    key={i}
                    className={`dot${i < cell.counted ? " filled" : ""}${pop && i === cell.counted - 1 ? " pop" : ""}`}
                  />
                ))}
                <span className="sr-only">
                  {Math.min(cell.counted, REPEATS)} of {REPEATS} runs done{isNext ? ", recommended next" : ""}
                </span>
                {isNext ? <span className="next-mark">next</span> : null}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

type Row = { label: string; tag?: Kind; get: (c: ModeCell) => string };

const ROWS: Row[] = [
  { label: "Counted trials", get: (c) => `${c.trials}` },
  { label: "Premature reply", tag: "M", get: (c) => rateText(c.premature) },
  { label: "Transcription correct", tag: "M", get: (c) => rateText(c.transcriptionCorrect) },
  { label: "Response appropriate", tag: "M", get: (c) => rateText(c.responseAppropriate) },
  { label: "Reply cancelled or cut short", tag: "M", get: (c) => rateText(c.replyCutShort) },
  { label: "Turn succeeded", tag: "M", get: (c) => rateText(c.succeeded) },
  { label: "Request split into turns", tag: "SDK", get: (c) => `${c.sdkSplits}/${c.trials}` },
  { label: "Reply turn not completed", tag: "SDK", get: (c) => `${c.sdkReplyNotCompleted}/${c.trials}` },
  { label: "Final transcript → first audio", tag: "SDK", get: (c) => spreadText(c.finalInputToFirstAudio) },
  { label: "Model → first text", tag: "SDK", get: (c) => spreadText(c.modelToFirstText) },
  { label: "TTS → first audio", tag: "SDK", get: (c) => spreadText(c.ttsToFirstAudio) },
  { label: "Speech start → final transcript", tag: "SDK", get: (c) => spreadText(c.speechStartToFinal) },
  { label: "Perceived wait", tag: "≈", get: (c) => spreadText(c.perceivedWait) },
  { label: "Technical failures", get: (c) => `${c.technicalFailures}` },
  { label: "Excluded / exploratory", get: (c) => `${c.excluded} / ${c.exploratory}` }
];

function CompareTable({ caption, standard, patient }: { caption: string; standard: ModeCell; patient: ModeCell }) {
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

/** Every measure, for all scenarios or one. Kept behind a disclosure so it never dominates. */
export function FullComparison({ report }: { report: Report }) {
  const [scope, setScope] = useState<number | "all">("all");
  const row = scope === "all" ? null : report.scenarios.find((r) => r.scenario === scope)!;
  const examples = row ? [row.standard, row.patient].flatMap((c) => c.prematureExamples.map((ex) => ({ ...ex, mode: c.mode }))) : [];
  return (
    <div>
      <div className="tabs" role="group" aria-label="Scope">
        {(["all", 1, 2, 3, 4, 5, 6] as const).map((s) => (
          <button
            type="button"
            key={s}
            className={scope === s ? "tab on" : "tab"}
            aria-pressed={scope === s}
            onClick={() => setScope(s)}
          >
            {s === "all" ? "All scenarios" : `Scenario ${s}`}
          </button>
        ))}
      </div>
      <CompareTable
        caption={row ? `Scenario ${row.scenario}: ${scenarioById(row.scenario)?.name}` : "All scenarios"}
        standard={row ? row.standard : report.totals.standard}
        patient={row ? row.patient : report.totals.patient}
      />
      {examples.map((ex) => (
        <blockquote className="example" key={ex.id}>
          <strong>{MODE_NAME[ex.mode]}, labelled premature:</strong>{" "}
          {ex.transcripts.map((t, i) => (
            <span className="turn" key={i}>
              {t}
            </span>
          ))}
          <br />
          Agent: {ex.reply || "no reply"}
        </blockquote>
      ))}
    </div>
  );
}

const GLOSSARY: { name: string; tag: Kind; start: string; stop: string; cannot: string }[] = [
  {
    name: "Speech start → final transcript",
    tag: "SDK",
    start: "Flux detects speech",
    stop: "Flux finalizes the transcript",
    cannot: "Includes your speaking time and every pause, so it is not latency. Shown for unsplit trials only."
  },
  {
    name: "Final transcript → first audio",
    tag: "SDK",
    start: "Transcript finalized",
    stop: "First speech audio leaves the server",
    cannot: "Leaves out the end-of-turn wait before it and playback after it. Not affected by the threshold."
  },
  {
    name: "Model → first text",
    tag: "SDK",
    start: "Model is called",
    stop: "Model's first text",
    cannot: "Varies run to run for reasons unrelated to turn-taking."
  },
  {
    name: "Perceived wait",
    tag: "≈",
    start: "Last mic level above the voice threshold",
    stop: "Browser starts playing the reply",
    cannot: "Room noise or a quiet last word moves its start. Compare modes; don't quote it as latency."
  },
  {
    name: "Judgments",
    tag: "M",
    start: "—",
    stop: "—",
    cannot: "One person who knows the hypothesis labels every trial. Unknowns never enter a rate."
  }
];

export function Glossary() {
  return (
    <div className="table-wrap">
      <table className="glossary">
        <thead>
          <tr>
            <th scope="col">Measure</th>
            <th scope="col">Starts</th>
            <th scope="col">Stops</th>
            <th scope="col">Cannot establish</th>
          </tr>
        </thead>
        <tbody>
          {GLOSSARY.map((g) => (
            <tr key={g.name}>
              <th scope="row">
                {g.name} <Tag kind={g.tag} />
              </th>
              <td>{g.start}</td>
              <td>{g.stop}</td>
              <td>{g.cannot}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const STATUS_LABEL: Record<TrialStatus, string> = {
  counted: "Counted",
  exploratory: "Exploratory",
  excluded: "Excluded",
  technical_failure: "Technical failure"
};

function TrialRow({
  trial,
  onExclude
}: {
  trial: Trial;
  onExclude?: (t: Trial, reason: string) => Promise<void>;
}) {
  const [excluding, setExcluding] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <details className="trial">
      <summary>
        <span className={`chip ${trial.status}`}>{STATUS_LABEL[trial.status]}</span>
        <span className="trial-id">
          S{trial.scenario} · {MODE_NAME[trial.mode]}
          {trial.run ? ` · run ${trial.run}` : ""}
        </span>
        <span className="trial-text">
          {trial.userTranscripts.join(" | ") || trial.statusReason || "no speech"}
        </span>
      </summary>
      <div className="trial-body">
        <dl className="evidence">
          <dt>
            Request <Tag kind="SDK" />
          </dt>
          <dd>{trial.userTranscripts.join(" | ") || "—"}</dd>
          <dt>
            Reply <Tag kind="SDK" />
          </dt>
          <dd>{trial.agentReply || "—"}</dd>
          <dt>
            Labels <Tag kind="M" />
          </dt>
          <dd>
            premature {trial.labels.premature} · transcription {trial.labels.transcriptionCorrect} ·
            reply {trial.labels.responseAppropriate} · cut short {trial.labels.replyCutShort}
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
        {trial.events.length ? (
          <details>
            <summary>Event timeline</summary>
            <Timeline events={trial.events} />
          </details>
        ) : null}
        {onExclude && (trial.status === "counted" || trial.status === "exploratory") ? (
          excluding ? (
            <form
              className="row"
              onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                await onExclude(trial, reason.trim());
                setBusy(false);
              }}
            >
              <label className="sr-only" htmlFor={`ex-${trial.id}`}>
                Reason for excluding
              </label>
              <input
                id={`ex-${trial.id}`}
                value={reason}
                placeholder="Why exclude it? (a few words)"
                onChange={(e) => setReason(e.target.value)}
              />
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy || reason.trim().length < 8}>
                Exclude
              </button>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setExcluding(false)}>
                Cancel
              </button>
            </form>
          ) : (
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setExcluding(true)}>
              Exclude this trial
            </button>
          )
        ) : null}
      </div>
    </details>
  );
}

export function TrialList({
  trials,
  onExclude
}: {
  trials: Trial[];
  onExclude?: (t: Trial, reason: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState<TrialStatus | "all">("all");
  const shown = [...trials].reverse().filter((t) => filter === "all" || t.status === filter);
  const count = (s: TrialStatus) => trials.filter((t) => t.status === s).length;
  return (
    <div>
      <div className="tabs" role="group" aria-label="Filter trials">
        <button type="button" className={filter === "all" ? "tab on" : "tab"} aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
          All {trials.length}
        </button>
        {(Object.keys(STATUS_LABEL) as TrialStatus[]).map((s) => (
          <button type="button" key={s} className={filter === s ? "tab on" : "tab"} aria-pressed={filter === s} onClick={() => setFilter(s)}>
            {STATUS_LABEL[s]} {count(s)}
          </button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="empty">Nothing here yet.</p>
      ) : (
        <div className="trial-list">
          {shown.map((t) => (
            <TrialRow key={t.id} trial={t} onExclude={onExclude} />
          ))}
        </div>
      )}
    </div>
  );
}
