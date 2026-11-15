import { useMemo } from "react";
import { EOT_THRESHOLD } from "../config";
import { DEMO_TRIALS } from "../lib/demo";
import { buildReport, percent } from "../lib/report";
import { Tag } from "./parts";
import { HeroViz, Pipeline, useReveal } from "./visuals";

const EXAMPLES = [
  {
    title: "A thinking pause",
    parts: ["I'd like a cleaning for", "Thursday afternoon."],
    note: "Two seconds of silence mid-sentence."
  },
  {
    title: "A filler and a restart",
    parts: ["Um, Wednesday", "no, Thursday."],
    note: "The first answer isn't the real one."
  },
  {
    title: "A self-correction",
    parts: ["Monday at two", "sorry, Tuesday at four."],
    note: "The detail that matters comes last."
  }
];

const STEPS = [
  {
    n: "01",
    title: "Pick the next trial",
    body: "Six scripted requests, two end-of-turn settings, two runs each. PaceLab recommends the next of 24 trials in a balanced order."
  },
  {
    n: "02",
    title: "Read the script",
    body: "A silent timer paces every pause. Nothing is played into the microphone, and the pauses you actually held are measured."
  },
  {
    n: "03",
    title: "Label what happened",
    body: "Did the agent reply early? Was it heard and answered correctly? Yes, No or Unable to determine. Failed starts never count."
  },
  {
    n: "04",
    title: "Compare the settings",
    body: "Rates use honest denominators. The report says Insufficient evidence until the data supports a call."
  }
];

export function Overview({ go }: { go: (route: "workbench" | "demo") => void }) {
  const ref = useReveal<HTMLDivElement>();
  const sample = useMemo(() => buildReport(DEMO_TRIALS), []);
  const s = sample.totals.standard.premature;
  const p = sample.totals.patient.premature;

  return (
    <div className="overview" ref={ref}>
      <section className="hero">
        <div className="hero-grid" aria-hidden="true" />
        <div className="container hero-inner">
          <div className="hero-copy">
            <p className="eyebrow">Turn-taking evaluation for voice agents</p>
            <h1 className="display">
              Voice agents should know <span className="accent-word">when to listen.</span>
            </h1>
            <p className="lead">
              Test how AI voice agents handle pauses, interruptions and corrections. Compare
              configurations and turn conversations into actionable evidence.
            </p>
            <div className="cta-row">
              <button type="button" className="btn btn-accent btn-lg" onClick={() => go("workbench")}>
                Start testing
              </button>
              <button type="button" className="btn btn-quiet btn-lg" onClick={() => go("demo")}>
                Explore the demo <span aria-hidden="true">→</span>
              </button>
            </div>
            <p className="fine">
              Built on the Cloudflare Agents SDK voice pipeline: Flux, Gemma 4, Aura.
            </p>
          </div>
          <HeroViz />
        </div>
      </section>

      <section className="section">
        <div className="container split">
          <div className="reveal">
            <p className="eyebrow">The problem</p>
            <h2 className="h-section">Demos pass. Real callers pause.</h2>
          </div>
          <div className="reveal">
            <p className="body-lg">
              A voice agent has to guess when you've finished. People stop to think, say
              &ldquo;um&rdquo;, and correct themselves. Each silence is a chance for the agent to
              answer half a request and talk over the rest. A happy-path demo never shows it.
            </p>
          </div>
        </div>
        <div className="container example-row">
          {EXAMPLES.map((e, i) => (
            <article className="example-card reveal" key={e.title} style={{ transitionDelay: `${i * 80}ms` }}>
              <h3>{e.title}</h3>
              <p className="utterance">
                <span>{e.parts[0]}</span>
                <span className="gap" aria-label="pause">
                  <i />
                  <i />
                  <i />
                </span>
                <span>{e.parts[1]}</span>
              </p>
              <p className="muted">{e.note}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="section section-alt">
        <div className="container">
          <div className="section-head reveal">
            <p className="eyebrow">What PaceLab measures</p>
            <h2 className="h-section">Evidence first, judgment second.</h2>
            <p className="body-lg muted">
              Every number keeps its source. Measurements and human judgments are stored apart, so a
              transcript split is never mistaken for a verdict.
            </p>
          </div>
          <div className="reveal">
            <Pipeline />
          </div>
          <div className="provenance">
            <article className="reveal">
              <Tag kind="SDK" />
              <h3>SDK timings</h3>
              <p>Server-clock timings from the Agents SDK: when the turn ended, how long the model and voice took.</p>
            </article>
            <article className="reveal">
              <Tag kind="M" />
              <h3>Human judgments</h3>
              <p>Did the agent reply early? Was the request heard and answered correctly? Asked after every call.</p>
            </article>
            <article className="reveal">
              <Tag kind={"≈"} />
              <h3>Browser estimates</h3>
              <p>The pauses you held and the wait you felt, from the microphone level. Approximate by design.</p>
            </article>
          </div>
        </div>
      </section>

      <section className="section">
        <div className="container">
          <div className="section-head reveal">
            <p className="eyebrow">How the experiment works</p>
            <h2 className="h-section">One variable. Twenty-four trials.</h2>
          </div>
          <div className="variable reveal" aria-label="The two configurations">
            <div>
              <span className="variable-name">Standard</span>
              <span className="variable-value">{EOT_THRESHOLD.standard.toFixed(2)}</span>
              <span className="muted">Ends the turn sooner</span>
            </div>
            <span className="variable-vs" aria-hidden="true">vs</span>
            <div>
              <span className="variable-name">Patient</span>
              <span className="variable-value patient">{EOT_THRESHOLD.patient.toFixed(2)}</span>
              <span className="muted">Waits for more certainty</span>
            </div>
            <p className="variable-note">
              <code>eotThreshold</code> is the only difference. Same prompt, model, voice and scripts.
            </p>
          </div>
          <ol className="steps">
            {STEPS.map((step, i) => (
              <li className="reveal" key={step.n} style={{ transitionDelay: `${i * 70}ms` }}>
                <span className="step-n">{step.n}</span>
                <h3>{step.title}</h3>
                <p>{step.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="section section-alt">
        <div className="container split split-wide">
          <div className="reveal">
            <p className="eyebrow">What you learn</p>
            <h2 className="h-section">Which setting interrupts less, and what waiting costs.</h2>
            <p className="body-lg muted">
              The Turn Failure Report shows premature replies per scenario, whether requests were
              heard and answered, and the extra wait. Until each mode has enough judged trials, it
              says so.
            </p>
            <button type="button" className="btn btn-primary" onClick={() => go("demo")}>
              See a full sample report
            </button>
          </div>
          <figure className="sample-card reveal" aria-label="Sample result built from synthetic demo data">
            <figcaption>
              <span className="badge badge-synthetic">Synthetic sample</span>
              Premature replies, all scenarios
            </figcaption>
            {[
              { name: "Standard", r: s, cls: "standard" },
              { name: "Patient", r: p, cls: "patient" }
            ].map((row) => (
              <div className="sample-row" key={row.name}>
                <span className="sample-name">{row.name}</span>
                <span className="sample-track">
                  <span className={`sample-bar ${row.cls}`} style={{ width: `${percent(row.r) ?? 0}%` }} />
                </span>
                <span className="sample-value">
                  {row.r.yes}/{row.r.judged}
                </span>
              </div>
            ))}
            <p className="sample-verdict">{sample.decision.headline}</p>
            <p className="fine">Invented data to show the format. Not a finding.</p>
          </figure>
        </div>
      </section>

      <section className="cta-band">
        <div className="container cta-band-inner reveal">
          <h2>Run your first trial in two minutes.</h2>
          <div className="cta-row">
            <button type="button" className="btn btn-accent btn-lg" onClick={() => go("workbench")}>
              Start testing
            </button>
            <button type="button" className="btn btn-on-dark btn-lg" onClick={() => go("demo")}>
              Explore the demo
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
