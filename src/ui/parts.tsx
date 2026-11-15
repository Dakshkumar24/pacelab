import { useState } from "react";
import { EOT_THRESHOLD, type Mode } from "../config";
import { describeFailure } from "../lib/failures";
import { nextRun } from "../lib/experiment";
import { type Scenario, scriptedPauses } from "../lib/scenarios";
import type { Judgment, Trial, TrialEvent, TrialStatus } from "../lib/trial";
import type { Capture } from "./useCall";

export const MODE_NAME: Record<Mode, string> = { standard: "Standard", patient: "Patient" };

/** Provenance tag: SDK measurement, manual judgment, or browser estimate. */
export function Tag({ kind }: { kind: "SDK" | "M" | "≈" }) {
  const title =
    kind === "SDK"
      ? "Measured by the Agents SDK on the server clock"
      : kind === "M"
        ? "Judged by the person running the trial"
        : "Estimated in the browser from the microphone level";
  return (
    <abbr className={`tag tag-${kind === "≈" ? "approx" : kind.toLowerCase()}`} title={title}>
      {kind}
    </abbr>
  );
}

/** The script with a silent visual timer on each pause. Nothing is played aloud. */
export function ScriptGuide({
  scenario,
  silenceSince,
  pausesHeld,
  live
}: {
  scenario: Scenario;
  silenceSince: number | null;
  pausesHeld: number;
  live: boolean;
}) {
  let pauseIndex = -1;
  return (
    <div className="script" aria-label="Script to read aloud">
      {scenario.parts.map((part, i) => {
        if ("say" in part) {
          return (
            <span className="say" key={i}>
              {part.say}
            </span>
          );
        }
        pauseIndex += 1;
        const done = live && pausesHeld > pauseIndex;
        const running = live && !done && pausesHeld === pauseIndex && silenceSince !== null;
        return (
          <span
            className={`pause${done ? " done" : ""}${running ? " running" : ""}`}
            key={running ? `${i}-${silenceSince}` : i}
            style={{ ["--pause" as string]: `${part.pauseSeconds}s` }}
          >
            <span className="pause-fill" />
            <span className="pause-text">pause {part.pauseSeconds} s</span>
          </span>
        );
      })}
    </div>
  );
}

/** Seconds and tenths since the call was ready. */
function clock(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function Timeline({ events }: { events: TrialEvent[] }) {
  if (events.length === 0) return <p className="muted">No events recorded.</p>;
  return (
    <ol className="timeline">
      {events.map((e, i) => (
        <li key={i}>
          <time>{clock(e.t)}</time>
          <span className="ev-type">{e.type.replace(/_/g, " ")}</span>
          {e.detail ? <span className="ev-detail">{e.detail}</span> : null}
        </li>
      ))}
    </ol>
  );
}

function Choice<T extends string>({
  legend,
  hint,
  name,
  value,
  options,
  onChange
}: {
  legend: React.ReactNode;
  hint?: string;
  name: string;
  value: T | "";
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="choice">
      <legend>{legend}</legend>
      {hint ? <p className="hint">{hint}</p> : null}
      <div className="segmented">
        {options.map((o) => (
          <label key={o.value} className={value === o.value ? "on" : ""}>
            <input
              type="radio"
              name={name}
              checked={value === o.value}
              onChange={() => onChange(o.value)}
            />
            {o.label}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

const YNU: { value: Judgment; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "unknown", label: "Unable to determine" }
];

/** Split the transcript into the request (before the first reply) and that reply. */
export function summarize(c: Capture) {
  const firstReply = c.lines.findIndex((l) => l.role === "assistant");
  const before = firstReply === -1 ? c.lines : c.lines.slice(0, firstReply);
  const userTranscripts = before.filter((l) => l.role === "user").map((l) => l.text);
  const answered = c.turns.find((t) => t.source === "speech" && t.outcome === "completed");
  const firstSpeech = answered ?? c.turns.find((t) => t.source === "speech");
  return {
    userTranscripts,
    agentReply: firstReply === -1 ? "" : c.lines[firstReply].text,
    turn: firstSpeech
  };
}

function baseTrial(c: Capture) {
  const s = summarize(c);
  return {
    schema: 2 as const,
    id: c.name,
    createdAt: Date.now(),
    mode: c.mode,
    scenario: c.scenario,
    run: 0,
    eotThreshold: EOT_THRESHOLD[c.mode],
    userTranscripts: s.userTranscripts,
    agentReply: s.agentReply,
    turnCount: s.userTranscripts.length,
    cutOffPresses: c.cutOffs,
    timings: s.turn
      ? {
          speechStartToFinalMs: s.turn.speechStartToFinalMs,
          afterTranscribeMs: s.turn.afterTranscribeMs,
          modelToFirstTextMs: s.turn.modelToFirstTextMs,
          ttsToFirstAudioMs: s.turn.ttsToFirstAudioMs,
          finalInputToFirstAudioMs: s.turn.finalInputToFirstAudioMs,
          turnTotalMs: s.turn.turnTotalMs,
          outcome: s.turn.outcome
        }
      : {},
    perceived: { approxSpeechEndToFirstAudioMs: c.perceivedMs, approxPausesMs: c.pausesMs },
    events: c.events,
    repaired: c.repaired
  };
}

async function postTrial(trial: unknown): Promise<{ ok: true; run: number } | { ok: false; error: string; expired: boolean }> {
  try {
    const res = await fetch("/api/trial", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(trial)
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; run?: number };
    if (res.ok) return { ok: true, run: data.run ?? 0 };
    return { ok: false, error: data.error ?? `Save failed (${res.status}).`, expired: res.status === 401 };
  } catch {
    return { ok: false, error: "Network error. Nothing was saved.", expired: false };
  }
}

/** Shown instead of the label form when a call produced nothing to judge. */
export function FailureCard({
  capture,
  onSaved,
  onDismiss,
  onExpired
}: {
  capture: Capture;
  onSaved: (message: string) => void;
  onDismiss: () => void;
  onExpired: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const f = describeFailure(capture.failure ?? "unknown");
  const noSpeech = capture.failure === null;
  const title = noSpeech ? "Nothing was recognized" : "The call failed";
  const message = noSpeech
    ? "The call connected, but no speech was committed as a turn and the agent did not reply."
    : f.message;
  const action = noSpeech
    ? "Check that the right microphone is selected and try again."
    : f.action;
  const slot = capture.wasLive
    ? "This call was live, so it used one call slot."
    : "The call never started, so no call slot was used.";

  async function record() {
    setBusy(true);
    setError(null);
    const out = await postTrial({
      ...baseTrial(capture),
      status: "technical_failure",
      statusReason: `${message}${capture.failureDetail ? ` Provider said: ${capture.failureDetail}` : ""}`,
      failureCode: noSpeech ? "no_speech" : f.code,
      labels: {},
      notes: ""
    });
    setBusy(false);
    if (out.ok) onSaved("Recorded as a technical failure. It is not part of the experiment counts.");
    else if (out.expired) onExpired();
    else setError(out.error);
  }

  return (
    <section className="card failure" aria-labelledby="failure-heading" role="alert">
      <h2 id="failure-heading">{title}</h2>
      <p>{message}</p>
      <p>
        <strong>What to do:</strong> {action}
      </p>
      <p className="muted">
        {slot} This is a technical failure, not a trial: there is nothing to label.
        {capture.failureDetail ? ` Provider response: ${capture.failureDetail}` : ""}
      </p>
      {capture.failure && capture.failure.startsWith("mic_") ? null : (
        <div className="row">
          <button type="button" onClick={record} disabled={busy}>
            {busy ? "Saving…" : "Record as technical failure"}
          </button>
          <button type="button" className="ghost" onClick={onDismiss} disabled={busy}>
            Dismiss
          </button>
        </div>
      )}
      {capture.failure && capture.failure.startsWith("mic_") ? (
        <button type="button" className="ghost" onClick={onDismiss}>
          Dismiss
        </button>
      ) : null}
      {error ? <p className="error">{error}</p> : null}
    </section>
  );
}

export function LabelForm({
  capture,
  scenario,
  trials,
  onSaved,
  onDiscard,
  onExpired
}: {
  capture: Capture;
  scenario: Scenario;
  trials: Trial[];
  onSaved: (message: string) => void;
  onDiscard: () => void;
  onExpired: () => void;
}) {
  const s = summarize(capture);
  const run = nextRun(trials, capture.scenario, capture.mode);
  const [premature, setPremature] = useState<Judgment | "">("");
  const [transcription, setTranscription] = useState<Judgment | "">("");
  const [response, setResponse] = useState<Judgment | "">("");
  const [cutShort, setCutShort] = useState<Judgment | "">("");
  const [status, setStatus] = useState<TrialStatus>(
    capture.failure ? "excluded" : run === null ? "exploratory" : "counted"
  );
  const [reason, setReason] = useState(
    capture.failure ? describeFailure(capture.failure).message : ""
  );
  const [repaired, setRepaired] = useState(capture.repaired);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const labelled = premature && transcription && response && cutShort;
  const ready = labelled && (status !== "excluded" || reason.trim().length >= 8);
  const scripted = scriptedPauses(scenario);

  async function save() {
    setBusy(true);
    setError(null);
    const out = await postTrial({
      ...baseTrial(capture),
      repaired,
      status,
      statusReason: status === "excluded" ? reason.trim() : "",
      failureCode: capture.failure ?? "",
      labels: {
        premature,
        transcriptionCorrect: transcription,
        responseAppropriate: response,
        replyCutShort: cutShort
      },
      notes: notes.trim()
    });
    setBusy(false);
    if (out.ok) {
      onSaved(
        status === "counted"
          ? `Saved: scenario ${capture.scenario}, ${MODE_NAME[capture.mode]}, run ${out.run} of 2.`
          : `Saved as ${status}. It does not change the experiment counts.`
      );
    } else if (out.expired) onExpired();
    else setError(out.error);
  }

  return (
    <section className="card" aria-labelledby="label-heading">
      <h2 id="label-heading">
        <span className="step">4</span> Label this call
      </h2>
      <p className="muted">
        Scenario {capture.scenario} ({scenario.name}) in {MODE_NAME[capture.mode]} mode. What to
        look for: {scenario.intent}
      </p>
      {capture.failure ? (
        <p className="notice">
          This call hit a technical problem: {describeFailure(capture.failure).message} It is set to
          Excluded. Change that only if the problem did not affect the test.
        </p>
      ) : null}

      <dl className="evidence">
        <dt>
          Recognized request <Tag kind="SDK" />
        </dt>
        <dd>
          {s.userTranscripts.map((t, i) => (
            <span className="turn" key={i}>
              {t}
            </span>
          ))}
        </dd>
        <dt>
          Committed turns before the reply <Tag kind="SDK" />
        </dt>
        <dd>
          {s.userTranscripts.length}
          {s.userTranscripts.length > 1
            ? " — the request was split. That is a measurement, not a verdict: you decide below whether the reply came too early."
            : ""}
        </dd>
        <dt>
          Agent's first reply <Tag kind="SDK" />
        </dt>
        <dd>
          {s.agentReply || "No reply"}
          {s.turn ? <span className="muted"> (turn outcome: {s.turn.outcome})</span> : null}
        </dd>
        <dt>
          Pauses you held <Tag kind={"≈"} />
        </dt>
        <dd>
          {capture.pausesMs.length
            ? capture.pausesMs.map((p) => `${(p / 1000).toFixed(1)} s`).join(", ")
            : "none detected"}
          <span className="muted">
            {" "}
            (script: {scripted.length ? scripted.map((p) => `${p} s`).join(", ") : "no pauses"})
          </span>
        </dd>
        <dt>
          "Cut me off" presses <Tag kind={"≈"} />
        </dt>
        <dd>{capture.cutOffs}</dd>
      </dl>

      <Choice
        legend={<>Did the agent reply before you finished? <Tag kind="M" /></>}
        name="premature"
        value={premature}
        options={YNU}
        onChange={setPremature}
      />
      <Choice
        legend={<>Was the transcription correct? <Tag kind="M" /></>}
        hint="Key intent and details captured. Exact wording is not required."
        name="transcription"
        value={transcription}
        options={YNU}
        onChange={setTranscription}
      />
      <Choice
        legend={<>Was the reply appropriate? <Tag kind="M" /></>}
        hint="It fits the whole request, not a fragment of it."
        name="response"
        value={response}
        options={YNU}
        onChange={setResponse}
      />
      <Choice
        legend={<>Was the spoken reply cancelled or cut short? <Tag kind="M" /></>}
        name="cutshort"
        value={cutShort}
        options={YNU}
        onChange={setCutShort}
      />
      <Choice
        legend="How should this trial be kept?"
        hint={
          run === null
            ? "This scenario and mode already have both planned runs, so a new run cannot be counted."
            : `Counted would be run ${run} of 2 for this scenario and mode.`
        }
        name="status"
        value={status}
        options={[
          ...(run === null ? [] : [{ value: "counted" as const, label: "Counted" }]),
          { value: "exploratory" as const, label: "Exploratory" },
          { value: "excluded" as const, label: "Excluded" }
        ]}
        onChange={setStatus}
      />
      {status === "excluded" ? (
        <>
          <label htmlFor="reason">Why is it excluded? (required)</label>
          <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </>
      ) : null}
      <label className="check">
        <input type="checkbox" checked={repaired} onChange={(e) => setRepaired(e.target.checked)} />
        I had to send a typed correction
      </label>
      <label htmlFor="notes">Notes</label>
      <input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />

      <div className="row">
        <button type="button" onClick={save} disabled={!ready || busy}>
          {busy ? "Saving…" : "Save trial"}
        </button>
        <button type="button" className="ghost" onClick={onDiscard} disabled={busy}>
          Discard without saving
        </button>
      </div>
      {!labelled ? <p className="muted">Answer all four questions to save.</p> : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
      <details>
        <summary>Event timeline for this call</summary>
        <Timeline events={capture.events} />
      </details>
    </section>
  );
}
