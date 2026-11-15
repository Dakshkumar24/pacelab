import { useCallback, useEffect, useState } from "react";
import { Demo } from "./ui/Demo";
import { Overview } from "./ui/Overview";
import { Results } from "./ui/Results";
import { useLabData } from "./ui/useLabData";
import { LogoMark } from "./ui/visuals";
import { Workbench } from "./ui/Workbench";

/**
 * The session token lives in an HttpOnly cookie, so this page cannot read it
 * and never puts it in a URL. All that is kept here is a flag saying the
 * passphrase was accepted; the server is still the thing that decides.
 */
function useSession() {
  const [signedIn, setSignedIn] = useState(() => sessionStorage.getItem("pacelab-signed-in") === "1");
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

const ROUTES = ["overview", "workbench", "results", "demo"] as const;
type Route = (typeof ROUTES)[number];
const LABEL: Record<Route, string> = { overview: "Overview", workbench: "Workbench", results: "Results", demo: "Demo" };

function readRoute(): Route {
  const h = location.hash.replace(/^#\/?/, "").split("?")[0] as Route;
  if (ROUTES.includes(h)) return h;
  return new URLSearchParams(location.search).has("demo") ? "demo" : "overview";
}

function useRoute() {
  const [route, setRoute] = useState<Route>(readRoute);
  useEffect(() => {
    const on = () => {
      setRoute(readRoute());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((r: Route) => {
    if (location.hash === `#/${r}`) window.scrollTo({ top: 0, behavior: "smooth" });
    else location.hash = `/${r}`;
  }, []);
  return { route, go };
}

function SignIn({ onEnter, onDemo, expired, purpose }: { onEnter: () => void; onDemo: () => void; expired: boolean; purpose: string }) {
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
    <div className="container page">
      <div className="gate">
        <form className="panel gate-form" onSubmit={submit}>
          <p className="eyebrow">Sign in</p>
          <h1 className="h-page">{purpose}</h1>
          <p className="muted">
            Live calls spend this deployment's Workers AI allocation, so the workbench and saved
            results need a passphrase.
          </p>
          {expired ? <p className="notice">Your session expired. Sign in again to continue.</p> : null}
          <label htmlFor="pass">Passphrase</label>
          <input id="pass" type="password" autoComplete="current-password" value={value} onChange={(e) => setValue(e.target.value)} required />
          <button type="submit" className="btn btn-primary" disabled={busy || !value}>
            {busy ? "Checking…" : "Sign in"}
          </button>
          <p className="error" role="alert">
            {error ?? ""}
          </p>
        </form>
        <aside className="panel gate-demo">
          <span className="badge badge-synthetic">No passphrase needed</span>
          <h2 className="h-block">See how it works first</h2>
          <p className="muted">
            Walk through a scripted test, a premature-response example and a full comparison report.
            The demo uses synthetic data, needs no microphone and calls no AI model.
          </p>
          <button type="button" className="btn btn-secondary" onClick={onDemo}>
            Open the demo
          </button>
        </aside>
      </div>
    </div>
  );
}

export function App() {
  const { signedIn, enter, leave } = useSession();
  const { route, go } = useRoute();
  const [expired, setExpired] = useState(false);
  const [menu, setMenu] = useState(false);

  const onExpired = useCallback(() => {
    setExpired(true);
    leave();
  }, [leave]);

  const lab = useLabData(signedIn, onExpired);
  const { refresh } = lab;

  useEffect(() => {
    setMenu(false);
    if (signedIn && (route === "workbench" || route === "results")) void refresh();
  }, [route, signedIn, refresh]);

  async function signOut() {
    await fetch("/api/session", { method: "DELETE" }).catch(() => {});
    leave();
    go("overview");
  }

  const gate = (purpose: string) => (
    <SignIn
      purpose={purpose}
      expired={expired}
      onDemo={() => go("demo")}
      onEnter={() => {
        setExpired(false);
        enter();
      }}
    />
  );

  return (
    <>
      <a className="skip" href="#main">
        Skip to content
      </a>
      <header className="nav">
        <div className="container nav-inner">
          <a className="brand" href="#/overview" aria-label="PaceLab home">
            <LogoMark />
            <span className="brand-name">PaceLab</span>
          </a>
          <button
            type="button"
            className="nav-toggle"
            aria-expanded={menu}
            aria-controls="nav-links"
            onClick={() => setMenu((m) => !m)}
          >
            <span className="sr-only">Menu</span>
            <span aria-hidden="true" className="burger" />
          </button>
          <nav id="nav-links" className={menu ? "nav-links open" : "nav-links"} aria-label="Main">
            {ROUTES.map((r) => (
              <a key={r} href={`#/${r}`} aria-current={route === r ? "page" : undefined} className="nav-link">
                {LABEL[r]}
              </a>
            ))}
            <span className="nav-side">
              {signedIn ? (
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => void signOut()}>
                  Sign out
                </button>
              ) : (
                <button type="button" className="btn btn-primary btn-sm" onClick={() => go("workbench")}>
                  Start testing
                </button>
              )}
            </span>
          </nav>
        </div>
      </header>

      <main id="main">
        {/* The Workbench stays mounted while signed in, so a call or an unlabeled capture survives navigation. */}
        {signedIn ? (
          <div className="route-view" hidden={route !== "workbench"}>
            <Workbench lab={lab} onExpired={onExpired} goResults={() => go("results")} />
          </div>
        ) : null}
        {route === "workbench" && signedIn ? null : (
          <div className="route-view" key={route}>
            {route === "overview" ? (
              <Overview go={go} />
            ) : route === "demo" ? (
              <Demo goWorkbench={() => go("workbench")} />
            ) : !signedIn ? (
              gate(route === "workbench" ? "Run real tests" : "See your results")
            ) : (
              <Results
                report={lab.report}
                trials={lab.trials}
                loadError={lab.loadError}
                onExpired={onExpired}
                refresh={lab.refresh}
                goWorkbench={() => go("workbench")}
              />
            )}
          </div>
        )}
      </main>

      <footer className="foot">
        <div className="container foot-inner">
          <span className="brand">
            <LogoMark size={18} />
            <span className="brand-name">PaceLab</span>
            <span className="foot-tag">Compare. Diagnose. Improve.</span>
          </span>
          <span className="muted">
            Open source. Built on the Cloudflare Agents SDK voice pipeline: Flux speech recognition,
            Gemma 4, Aura text-to-speech.
          </span>
        </div>
      </footer>
    </>
  );
}
