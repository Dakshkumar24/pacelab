import { useCallback, useState } from "react";
import { Demo } from "./ui/Demo";
import { Workbench } from "./ui/Workbench";

/**
 * The session token lives in an HttpOnly cookie, so this page cannot read it
 * and never puts it in a URL. All that is kept here is a flag saying the
 * passphrase was accepted; the server is still the thing that decides.
 */
function useSession() {
  const [signedIn, setSignedIn] = useState(
    () => sessionStorage.getItem("pacelab-signed-in") === "1"
  );
  const enter = useCallback(() => {
    sessionStorage.setItem("pacelab-signed-in", "1");
    setSignedIn(true);
  }, []);
  const leave = useCallback(() => {
    sessionStorage.removeItem("pacelab-signed-in");
    setSignedIn(false);
  }, []);
  return { signedIn, enter, leave };
}

function Gate({ onEnter, onDemo, expired }: { onEnter: () => void; onDemo: () => void; expired: boolean }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passphrase: value })
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setError(data.error ?? "Could not sign in.");
        return;
      }
      setValue("");
      onEnter();
    } catch {
      setError("Network error.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate">
      <section className="card">
        <h2>See how it works</h2>
        <p>
          Walk through a scripted test, a premature-response example and a full comparison report.
          The demo uses synthetic data, needs no microphone and calls no AI model.
        </p>
        <button type="button" className="primary" onClick={onDemo}>
          Open the demo
        </button>
      </section>
      <form className="card" onSubmit={submit}>
        <h2>Run real tests</h2>
        <p className="muted">
          Live calls spend this deployment's Workers AI allocation, so the workbench needs a
          passphrase.
        </p>
        {expired ? <p className="notice">Your session expired. Sign in again to continue.</p> : null}
        <label htmlFor="pass">Passphrase</label>
        <input
          id="pass"
          type="password"
          autoComplete="current-password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          required
        />
        <button type="submit" disabled={busy || !value}>
          {busy ? "Checking…" : "Sign in"}
        </button>
        <p className="error" role="alert">
          {error ?? ""}
        </p>
      </form>
    </div>
  );
}

export function App() {
  const { signedIn, enter, leave } = useSession();
  const [demo, setDemo] = useState(() => new URLSearchParams(location.search).has("demo"));
  const [expired, setExpired] = useState(false);

  const onExpired = useCallback(() => {
    setExpired(true);
    leave();
  }, [leave]);

  async function signOut() {
    await fetch("/api/session", { method: "DELETE" }).catch(() => {});
    leave();
  }

  return (
    <main className="shell">
      <header className="masthead">
        <div>
          <h1>
            PaceLab <span className="tagline">Compare. Diagnose. Improve.</span>
          </h1>
          <p className="lede">
            A test bench for voice-agent turn-taking. Read a scripted request with natural pauses to
            two end-of-turn settings, label what the agent did, and compare them on evidence.
          </p>
        </div>
        <nav className="masthead-actions">
          {signedIn && !demo ? (
            <>
              <button type="button" className="ghost" onClick={() => setDemo(true)}>
                Demo
              </button>
              <button type="button" className="ghost" onClick={() => void signOut()}>
                Sign out
              </button>
            </>
          ) : null}
        </nav>
      </header>
      <ol className="flow" aria-label="Workflow">
        {["Configure", "Speak", "Observe", "Label", "Compare", "Decide"].map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ol>
      {demo ? (
        <Demo onExit={() => setDemo(false)} />
      ) : signedIn ? (
        <Workbench onExpired={onExpired} />
      ) : (
        <Gate
          expired={expired}
          onDemo={() => setDemo(true)}
          onEnter={() => {
            setExpired(false);
            enter();
          }}
        />
      )}
      <footer className="foot">
        Open source. Built on the Cloudflare Agents SDK voice pipeline: Flux speech recognition,
        Gemma 4, Aura text-to-speech.
      </footer>
    </main>
  );
}
