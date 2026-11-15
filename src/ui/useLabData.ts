import { useCallback, useEffect, useMemo, useState } from "react";
import type { Usage } from "../lib/quota";
import { buildReport } from "../lib/report";
import type { Trial } from "../lib/trial";

/**
 * Saved trials and today's usage, shared by the Workbench and Results pages.
 * The report is computed in the browser with the same code the server uses.
 */
export function useLabData(enabled: boolean, onExpired: () => void) {
  const [trials, setTrials] = useState<Trial[] | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    try {
      const [u, t] = await Promise.all([fetch("/api/usage"), fetch("/api/trials")]);
      if (u.status === 401 || t.status === 401) return onExpired();
      if (!u.ok || !t.ok) throw new Error();
      setUsage((await u.json()) as Usage);
      setTrials(((await t.json()) as { trials: Trial[] }).trials);
      setLoadError(null);
    } catch {
      setLoadError("Could not load saved trials. Check your connection and reload.");
    }
  }, [enabled, onExpired]);

  useEffect(() => {
    if (enabled) void refresh();
    else {
      setTrials(null);
      setUsage(null);
    }
  }, [enabled, refresh]);

  const report = useMemo(() => buildReport(trials ?? []), [trials]);
  return { trials, usage, report, refresh, loadError };
}

export type LabData = ReturnType<typeof useLabData>;
