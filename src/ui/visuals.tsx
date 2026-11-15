import { useEffect, useRef } from "react";

/** Adds `in` to every `.reveal` element below the root as it scrolls into view. */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const els = [...root.querySelectorAll<HTMLElement>(".reveal")];
    if (!("IntersectionObserver" in window)) {
      for (const el of els) el.classList.add("in");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
    );
    for (const el of els) io.observe(el);
    return () => io.disconnect();
  }, []);
  return ref;
}

/** The PaceLab mark: a waveform with a held gap. */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="logo-mark">
      <rect x="1" y="9" width="2.6" height="6" rx="1.3" />
      <rect x="5.4" y="5" width="2.6" height="14" rx="1.3" />
      <rect x="9.8" y="8" width="2.6" height="8" rx="1.3" />
      <circle cx="16" cy="12" r="1.1" className="logo-gap" />
      <rect x="19.6" y="4" width="2.6" height="16" rx="1.3" className="logo-accent" />
    </svg>
  );
}

/** Bar heights for a short spoken phrase, deterministic so the picture never jitters. */
function bars(count: number, seed: number): number[] {
  const out: number[] = [];
  let x = seed;
  for (let i = 0; i < count; i++) {
    x = (x * 9301 + 49297) % 233280;
    const envelope = Math.sin((Math.PI * (i + 0.5)) / count);
    out.push(6 + Math.round((x / 233280) * 22 * envelope + 8 * envelope));
  }
  return out;
}

const PHRASES = [
  { x: 112, n: 16, seed: 7 },
  { x: 288, n: 14, seed: 19 },
  { x: 446, n: 9, seed: 31 }
];

function Waveform({ y }: { y: number }) {
  return (
    <g>
      {PHRASES.flatMap((p) =>
        bars(p.n, p.seed).map((h, i) => (
          <rect key={`${p.x}-${i}`} x={p.x + i * 6} y={y - h / 2} width="3.2" height={h} rx="1.6" />
        ))
      )}
    </g>
  );
}

/**
 * Hero picture. The same request travels down two lanes. During the first
 * pause, Standard commits the turn and replies; Patient keeps listening and
 * replies after the request ends. One 9-second CSS loop, no JavaScript.
 * With reduced motion it shows the final frame.
 */
export function HeroViz() {
  const lanes = [
    { y: 112, name: "Standard", sub: "eotThreshold 0.70", cls: "lane-standard", id: "hv-s" },
    { y: 252, name: "Patient", sub: "eotThreshold 0.85", cls: "lane-patient", id: "hv-p" }
  ];
  return (
    <figure
      className="hero-viz"
      aria-label="Animation: the same paused request sent to two settings. Standard replies during the pause; Patient waits for the whole request."
    >
      <svg viewBox="0 0 560 330" aria-hidden="true">
        <defs>
          <pattern id="hv-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="6" className="hatch" />
          </pattern>
          {lanes.map((l) => (
            <clipPath id={l.id} key={l.id}>
              <rect x="104" y={l.y - 34} width="440" height="68" className="reveal-rect" />
            </clipPath>
          ))}
        </defs>
        {lanes.map((l) => (
          <g key={l.name} className={`lane ${l.cls}`}>
            <text x="18" y={l.y - 4} className="lane-name">
              {l.name}
            </text>
            <text x="18" y={l.y + 13} className="lane-sub">
              {l.sub.replace("eotThreshold ", "")}
            </text>
            <line x1="104" x2="544" y1={l.y + 30} y2={l.y + 30} className="lane-axis" />
            <rect x="210" y={l.y - 28} width="74" height="56" rx="6" fill="url(#hv-hatch)" className="pause-zone" />
            <rect x="372" y={l.y - 28} width="72" height="56" rx="6" fill="url(#hv-hatch)" className="pause-zone" />
            <g className="wave-dim">
              <Waveform y={l.y} />
            </g>
            <g className="wave-lit" clipPath={`url(#${l.id})`}>
              <Waveform y={l.y} />
            </g>
            <line x1="104" x2="104" y1={l.y - 36} y2={l.y + 36} className="playhead" />
          </g>
        ))}
        <g className="ev ev-early">
          <rect x="190" y="38" width="116" height="26" rx="13" className="pill" />
          <text x="248" y="55">
            Agent replies
          </text>
          <rect x="248" y="139" width="58" height="6" rx="3" className="reply-bar" />
        </g>
        <g className="ev ev-cut">
          <circle cx="306" cy="112" r="11" />
          <path d="M301.5 107.5 l9 9 M310.5 107.5 l-9 9" />
        </g>
        <g className="ev ev-late">
          <rect x="424" y="178" width="116" height="26" rx="13" className="pill" />
          <text x="482" y="195">
            Agent replies
          </text>
          <rect x="482" y="279" width="62" height="6" rx="3" className="reply-bar" />
        </g>
        <g className="ev ev-verdict ev-verdict-s">
          <rect x="18" y="128" width="76" height="22" rx="11" />
          <text x="56" y="143">
            Too early
          </text>
        </g>
        <g className="ev ev-verdict ev-verdict-p">
          <rect x="18" y="268" width="76" height="22" rx="11" />
          <text x="56" y="283">
            Waited
          </text>
        </g>
      </svg>
      <figcaption>
        <span>
          <i className="key key-pause" /> Pause in speech
        </span>
        <span>
          <i className="key key-reply" /> Agent takes the turn
        </span>
        <span className="fine">Illustration</span>
      </figcaption>
    </figure>
  );
}

/** Speech → turn detection → model → voice, with what PaceLab measures under each span. */
export function Pipeline() {
  const stages = ["Speech", "Turn detection", "Model", "Voice"];
  return (
    <div className="pipeline" aria-label="Voice pipeline and where each measurement starts and stops">
      <div className="pipe-track">
        <div className="pipe-flow" aria-hidden="true">
          <i />
          <i />
          <i />
        </div>
        {stages.map((s, i) => (
          <div className="pipe-stage" key={s}>
            <span className="pipe-dot" aria-hidden="true" />
            <span className="pipe-label">{s}</span>
            <span className="pipe-sub">
              {["Flux STT", "Flux end of turn", "Gemma 4", "Aura-1"][i]}
            </span>
          </div>
        ))}
      </div>
      <div className="pipe-spans">
        <div className="span span-sdk" style={{ gridColumn: "1 / 3" }}>
          <b>SDK</b> speech start → final transcript
        </div>
        <div className="span span-sdk" style={{ gridColumn: "3 / 5" }}>
          <b>SDK</b> final transcript → first audio
        </div>
        <div className="span span-approx" style={{ gridColumn: "2 / 5" }}>
          <b>≈</b> perceived wait, last word → first audio
        </div>
      </div>
    </div>
  );
}

/** Live microphone level. Flat when no call is live, so it never suggests activity that isn't there. */
export function MicMeter({ level, live }: { level: number; live: boolean }) {
  const shape = [0.35, 0.6, 0.85, 1, 0.75, 0.5, 0.9, 0.65, 0.4, 0.7, 0.95, 0.55, 0.3];
  const amp = live ? Math.min(1, level * 6) : 0;
  return (
    <div className={live ? "mic-meter live" : "mic-meter"} aria-hidden="true">
      {shape.map((s, i) => (
        <span key={i} style={{ transform: `scaleY(${Math.max(0.12, amp * s)})` }} />
      ))}
    </div>
  );
}
