import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEMO_REPLAYS, DEMO_TRIALS } from "../lib/demo";
import { buildReport } from "../lib/report";
import { SCENARIOS } from "../lib/scenarios";
import { ResultsBody } from "./Results";
import { ScriptGuide } from "./parts";

/** Invented timeline length, in milliseconds of call time. */
const SPAN = 12500;
/** Playback runs a little faster than real time. */
const SPEED = 1.5;

const SPEECH = [
  [0, 1400],
  [3400, 4700],
  [6700, 8000]
];
const PAUSES = [
  [1400, 3400],
  [4700, 6700]
];

const LANES = [
  {
    mode: "standard" as const,
    name: "Standard",
    threshold: "0.70",
    commit: 2100,
    reply: [4300, 4600],
    replyText: "Sure, when would you like to come in?",
    cut: true
  },
  {
    mode: "patient" as const,
    name: "Patient",
    threshold: "0.85",
    commit: 8300,
    reply: [10900, 12400],
    replyText: "Got it, next Thursday at eleven works.",
    cut: false
  }
];

const STAGES = [
  { from: 0, label: "Speaking" },
  { from: 1400, label: "Pause" },
  { from: 2100, label: "Standard commits" },
  { from: 4700, label: "Patient waits" },
  { from: 8300, label: "Response" },
  { from: SPAN, label: "Evaluation" }
];

const pct = (t: number) => `${(t / SPAN) * 100}%`;

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** The two-lane replay. Driven by one clock; nothing is fetched, recorded or played aloud. */
function TimelinePlayer() {
  const [t, setT] = useState(() => (reducedMotion() ? SPAN : 0));
  const [playing, setPlaying] = useState(false);
  const raf = useRef(0);
  const origin = useRef(0);

  const stop = useCallback(() => {
    cancelAnimationFrame(raf.current);
    setPlaying(false);
  }, []);

  const play = useCallback(
    (from: number) => {
      cancelAnimationFrame(raf.current);
      if (reducedMotion()) {
        setT(SPAN);
        return;
      }
      origin.current = performance.now() - from / SPEED;
      setPlaying(true);
      const tick = (now: number) => {
        const next = Math.min(SPAN, (now - origin.current) * SPEED);
        setT(next);
        if (next < SPAN) raf.current = requestAnimationFrame(tick);
        else setPlaying(false);
      };
      raf.current = requestAnimationFrame(tick);
    },
    []
  );

  useEffect(() => {
    const id = setTimeout(() => play(0), 600);
    return () => {
      clearTimeout(id);
      cancelAnimationFrame(raf.current);
    };
  }, [play]);

  const stage = STAGES.reduce((acc, s, i) => (t >= s.from ? i : acc), 0);
  const finished = t >= SPAN;
  const events = DEMO_REPLAYS.map((r) => r.events.filter((e) => e.t <= t));

  return (
    <div className="player">
      <ol className="stages" aria-label="Stages">
        {STAGES.map((s, i) => (
          <li key={s.label} className={i < stage ? "past" : i === stage ? "on" : ""} aria-current={i === stage ? "step" : undefined}>
            {s.label}
          </li>
        ))}
      </ol>

      <div className="tl" role="img" aria-label="Synthetic timeline of scenario 6 in both modes. Standard commits the turn 0.7 seconds into the first pause and its reply is cut off; Patient waits through both pauses and replies after the full request.">
        <div className="tl-scale" aria-hidden="true">
          {[0, 2, 4, 6, 8, 10, 12].map((s) => (
            <span key={s} style={{ left: pct(s * 1000) }}>
              {s}s
            </span>
          ))}
        </div>
        {LANES.map((lane) => (
          <div className={`tl-lane ${lane.mode}`} key={lane.mode}>
            <div className="tl-name">
              <b>{lane.name}</b>
              <code>{lane.threshold}</code>
            </div>
            <div className="tl-track">
              {PAUSES.map(([a, b]) => (
                <span key={a} className="tl-pause" style={{ left: pct(a), width: pct(b - a) }} />
              ))}
              {SPEECH.map(([a, b]) => (
                <span
                  key={a}
                  className="tl-speech"
                  style={{ left: pct(a), width: pct(Math.max(0, Math.min(b, t) - a)) }}
                />
              ))}
              {t >= lane.commit ? (
                <span className="tl-commit" style={{ left: pct(lane.commit) }}>
                  <span>turn committed</span>
                </span>
              ) : null}
              {t >= lane.reply[0] ? (
                <span
                  className={lane.cut ? "tl-reply cut" : "tl-reply"}
                  style={{ left: pct(lane.reply[0]), width: pct(Math.min(t, lane.reply[1]) - lane.reply[0]) }}
                />
              ) : null}
              {t >= lane.reply[0] ? (
                <span className="tl-say" style={{ left: pct(lane.reply[0]) }}>
                  “{lane.replyText}”{lane.cut && t >= lane.reply[1] ? <em> cut off</em> : null}
                </span>
              ) : null}
            </div>
          </div>
        ))}
        <span className="tl-head" style={{ ["--frac" as string]: t / SPAN }} aria-hidden="true" />
      </div>

      <div className="player-controls">
        {playing ? (
          <button type="button" className="btn btn-secondary btn-sm" onClick={stop}>
            Pause
          </button>
        ) : (
          <button type="button" className="btn btn-primary btn-sm" onClick={() => play(finished ? 0 : t)}>
            {finished ? "Replay" : t > 0 ? "Resume" : "Play"}
          </button>
        )}
        <span className="fine">
          {(t / 1000).toFixed(1)} s of {(SPAN / 1000).toFixed(1)} s · synthetic, {SPEED}× speed, no audio
        </span>
      </div>

      <div className="tl-logs">
        {DEMO_REPLAYS.map((r, i) => (
          <article className={`tl-log ${r.mode}`} key={r.mode}>
            <h3>{r.title}</h3>
            <ol className="timeline">
              {events[i].map((e, j) => (
                <li key={j} className={`ev-${e.type.replace(/ /g, "-")}`}>
                  <time>{(e.t / 1000).toFixed(1)}s</time>
                  <span className="ev-type">{e.type}</span>
                  <span className="ev-detail">{e.detail}</span>
                </li>
              ))}
            </ol>
          </article>
        ))}
      </div>

      <div className={finished ? "eval show" : "eval"} aria-hidden={!finished}>
        <article className="eval-card bad">
          <span className="eval-mode">Standard</span>
          <p className="eval-verdict">Premature: Yes</p>
          <p>{DEMO_REPLAYS[0].verdict}</p>
        </article>
        <article className="eval-card good">
          <span className="eval-mode">Patient</span>
          <p className="eval-verdict">Premature: No</p>
          <p>{DEMO_REPLAYS[1].verdict} The cost: a longer wait after the last word.</p>
        </article>
      </div>
    </div>
  );
}

export function Demo({ goWorkbench }: { goWorkbench: () => void }) {
  const report = useMemo(() => buildReport(DEMO_TRIALS), []);
  return (
    <div className="container page">
      <header className="page-head">
        <div>
          <p className="eyebrow">Demo</p>
          <h1 className="h-page">One request, two thresholds</h1>
        </div>
        <button type="button" className="btn btn-accent" onClick={goWorkbench}>
          Run it for real
        </button>
      </header>

      <div className="banner banner-demo" role="note">
        <span className="badge badge-synthetic">Synthetic</span>
        <span>
          <strong>Demo with synthetic data.</strong> Every transcript, label and number on this page
          was invented to show how PaceLab works. Nothing here was measured, nothing is saved, and no
          AI model is called.
        </span>
      </div>

      <section className="block">
        <div className="block-head">
          <h2 className="h-block">Scenario 6: multiple pauses</h2>
          <p className="muted">The script the tester reads. In a real call each pause marker fills while the pause is held.</p>
        </div>
        <div className="panel">
          <ScriptGuide scenario={SCENARIOS[5]} silenceSince={null} pausesHeld={0} live={false} />
        </div>
      </section>

      <section className="block">
        <div className="block-head">
          <h2 className="h-block">What each configuration did</h2>
          <p className="muted">An invented example of the failure PaceLab looks for: the agent taking its turn during a pause.</p>
        </div>
        <div className="panel">
          <TimelinePlayer />
        </div>
      </section>

      <div className="section-divider">
        <span className="badge badge-synthetic">Synthetic</span>
        <span>A full sample report from 24 invented trials and one invented technical failure</span>
      </div>

      <ResultsBody report={report} trials={DEMO_TRIALS} demo />
    </div>
  );
}
