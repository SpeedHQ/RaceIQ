import { useCallback, useEffect, useState } from "react";
import { useSettings } from "@/hooks/settings";
import { isAiAnalysisConfigured, launchAiFeature } from "@/lib/is-ai-configured";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { type AnalysisSummary, type InputsAnalysis, summarize } from "./compare-ai-types";

export function useLapAnalysis(lapId: number, panelOpen: boolean) {
  const [summary, setSummary] = useState<AnalysisSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCached = useCallback(async () => {
    try {
      const res = await client.api.laps[":id"].analyse.$post({ param: { id: String(lapId) }, query: { cacheOnly: "true" } });
      if (!res.ok) return;
      const data = (await res.json()) as { analysis: string | object | null; cached: boolean };
      if (!data.cached || !data.analysis) return;
      const parsed = typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis;
      setSummary(summarize(parsed));
    } catch {
      /* ignore */
    }
  }, [lapId]);

  const run = useCallback(
    async (regenerate = false) => {
      setLoading(true);
      setError(null);
      try {
        const res = await client.api.laps[":id"].analyse.$post({ param: { id: String(lapId) }, query: regenerate ? { regenerate: "true" } : {} });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({ error: m.compare_unknown_error() }))) as { error?: string };
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { analysis: string | object | null };
        const parsed = typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis;
        setSummary(summarize(parsed));
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : m.compare_analyse_failed());
      } finally {
        setLoading(false);
      }
    },
    [lapId],
  );

  useEffect(() => {
    if (panelOpen) loadCached();
  }, [lapId, panelOpen, loadCached]);
  useEffect(() => {
    setSummary(null);
    setError(null);
  }, [lapId]);
  return { summary, loading, error, run };
}

export function useInputsAnalysis(lapAId: number, lapBId: number, panelOpen: boolean) {
  const [analysis, setAnalysis] = useState<InputsAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadCached = useCallback(async () => {
    try {
      const res = await fetch(`/api/laps/${lapAId}/compare/${lapBId}/inputs-analyse?cacheOnly=true`, { method: "POST" });
      if (!res.ok) return;
      const data = (await res.json()) as { analysis: string | object | null; cached: boolean };
      if (!data.cached || !data.analysis) return;
      setAnalysis(typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis);
    } catch {
      /* ignore */
    }
  }, [lapAId, lapBId]);
  const run = useCallback(
    async (regenerate = false) => {
      setLoading(true);
      setError(null);
      try {
        const url = `/api/laps/${lapAId}/compare/${lapBId}/inputs-analyse${regenerate ? "?regenerate=true" : ""}`;
        const res = await fetch(url, { method: "POST" });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({ error: m.compare_unknown_error() }))) as { error?: string };
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { analysis: string | object | null };
        setAnalysis(typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : m.compare_analyse_inputs_failed());
      } finally {
        setLoading(false);
      }
    },
    [lapAId, lapBId],
  );
  useEffect(() => {
    if (panelOpen) loadCached();
  }, [panelOpen, loadCached]);
  useEffect(() => {
    setAnalysis(null);
    setError(null);
  }, [lapAId, lapBId]);
  return { analysis, loading, error, run };
}

export function useAiRunAction(aiConfigured: boolean, run: (regenerate?: boolean) => Promise<void>, configureAi: () => void) {
  return useCallback((regenerate = false) => launchAiFeature(aiConfigured, () => void run(regenerate), configureAi), [aiConfigured, configureAi, run]);
}

export function useComparisonAiSettings() {
  const { displaySettings } = useSettings();
  return { aiConfigured: isAiAnalysisConfigured(displaySettings) };
}
