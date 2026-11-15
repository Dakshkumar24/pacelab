import { useEffect, useMemo, useState } from "react";
import { DEMO_REPLAYS, DEMO_TRIALS, type DemoReplay } from "../lib/demo";
import { buildReport } from "../lib/report";
import { SCENARIOS } from "../lib/scenarios";
import { Matrix, ReportView } from "./Report";
import { ScriptGuide } from "./parts";

/** Plays an invented timeline at four times real speed. No audio, no network. */
function Replay({ replay, playing }: { replay: DemoReplay; playing: number }) {
  const [shown, setShown] = useState(replay.events.length);
  useEffect(() => {
    if (!playing) return;
    setShown(0);
    const timers = replay.events.map((e, i) => setTimeout(() => setShown(i + 1), e.t / 4 + 200));
    return () => timers.forEach(clearTimeout);
  }, [playing, replay]);
  return (
    <div className="replay">
      <h3>{replay.title}</h3>
      <ol className="timeline">
        {replay.events.slice(0, shown).map((e, i) => (
          <li key={i} className={`ev-${e.type.replace(/ /g, "-")}`}>
            <time>{(e.t / 1000).toFixed(1)}s</time>
            <span className="ev-type">{e.type}</span>
            <span className="ev-detail">{e.detail}</span>
          </li>
        ))}
      </ol>
      {shown === replay.events.length ? <p className="muted">{replay.verdict}</p> : null}
    </div>
  );
}

export function Demo({ onExit }: { onExit: () => void }) {
  const report = useMemo(() => buildReport(DEMO_TRIALS), []);
  const [playing, setPlaying] = useState(0);
  return (
    <>
      <div className="banner demo-banner" role="note">
        <strong>Demo with synthetic data.</strong> Every transcript, label and number on this page
        was invented to show how PaceLab works. Nothing here was measured, nothing is saved, and no
        AI model is called.{" "}
        <button type="button" className="link" onClick={onExit}>
          Leave the demo
        </button>
      </div>

      <section className="card">
        <h2>
          <span className="step">1</span> A scripted request with pauses
        </h2>
        <p className="muted">
          Each trial reads one of six scripts to one of two configurations. This is scenario 6. In a
          real call the pause markers fill as you hold each pause.
        </p>
        <ScriptGuide scenario={SCENARIOS[5]} silenceSince={null} pausesHeld={0} live={false} />
      </section>

      <section className="card">
        <h2>
          <span className="step">2</span> The same request, two thresholds
        </h2>
        <p className="muted">
          An invented example of the failure PaceLab looks for: the agent taking its turn during a
          pause.
        </p>
        <button type="button" onClick={() => setPlaying((n) => n + 1)}>
          {playing ? "Replay" : "Play the example"}
        </button>
        <div className="replays">
          {DEMO_REPLAYS.map((r) => (
            <Replay key={r.mode} replay={r} playing={playing} />
          ))}
        </div>
      </section>

      <section className="card">
        <h2>
          <span className="step">3</span> Twenty-four planned trials
        </h2>
        <p className="muted">
          Six scenarios, two modes, two runs each. After every call a person labels what happened;
          only trials saved as Counted fill this grid.
        </p>
        <Matrix report={report} />
      </section>

      <ReportView report={report} trials={DEMO_TRIALS} demo />
    </>
  );
}
