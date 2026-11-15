import { EOT_THRESHOLD } from "./config";

export function App() {
  return (
    <main className="shell">
      <header>
        <h1>PaceLab</h1>
        <p className="tagline">Compare. Diagnose. Improve.</p>
      </header>
      <p>
        Turn-taking testbench. Standard mode uses <code>eotThreshold {EOT_THRESHOLD.standard}</code>,
        Patient mode uses <code>eotThreshold {EOT_THRESHOLD.patient}</code>.
      </p>
      <p className="muted">Phase 1 scaffold. The testbench arrives in Phase 3.</p>
    </main>
  );
}
