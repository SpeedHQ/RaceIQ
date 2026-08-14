import { useCallback, useEffect, useState } from "react";
import { useSettings } from "@/hooks/settings";
import { type ChatStreamError, readChatStream } from "@/lib/chat-stream";
import { isAiAnalysisConfigured, launchAiFeature } from "@/lib/is-ai-configured";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { type AnalysisSummary, type InputsAnalysis, summarize } from "./compare-ai-types";

function formatAnalysisStreamError(event: ChatStreamError): string {
  const statusCode = typeof event.statusCode === "number" ? event.statusCode : event.upstream?.code;
  const status = event.upstream?.status;
  return `${event.message}${statusCode || status ? ` (${statusCode ?? "error"}${status ? ` ${status}` : ""})` : ""}`;
}

type AnalysisStatus = { status?: "none" | "active" | "finished" | "failed"; error?: string };

export function useLapAnalysis(lapId: number, qualityStateKey: string, panelOpen: boolean) {
  const [summary, setSummary] = useState<AnalysisSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadCached = useCallback(async () => {
    try {
      const res = await client.api.laps[":id"].analyse.$post({ param: { id: String(lapId) }, query: { cacheOnly: "true" } });
      if (!res.ok) return;
      const data = (await res.json()) as { analysis: string | object | null; cached: boolean };
      if (!data.cached || !data.analysis) return;
      const parsed = typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis;
      setSummary(summarize(parsed));
    } catch {
      /* cache probing is best-effort */
    }
  }, [lapId, qualityStateKey]);

  const run = useCallback(
    async (regenerate = false) => {
      setLoading(true);
      setError(null);
      try {
        const query = regenerate ? "?regenerate=true" : "";
        const res = await fetch(`/api/laps/${lapId}/analyse${query}`, { method: "POST" });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({ error: m.compare_unknown_error() }))) as { error?: string };
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("application/x-ndjson")) {
          let resolved = false;
          await readChatStream(res, (event) => {
            if (event.type === "error") throw new Error(formatAnalysisStreamError(event as ChatStreamError));
            if (event.type !== "result") return;
            const result = event as { analysis?: string | object | null };
            if (!result.analysis) throw new Error(m.compare_analyse_failed());
            const parsed = typeof result.analysis === "string" ? JSON.parse(result.analysis) : result.analysis;
            setSummary(summarize(parsed));
            resolved = true;
          });
          if (!resolved) throw new Error(m.compare_analyse_failed());
        } else {
          const data = (await res.json()) as { analysis: string | object | null; error?: string };
          if (data.error || !data.analysis) throw new Error(data.error || m.compare_analyse_failed());
          const parsed = typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis;
          setSummary(summarize(parsed));
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : m.compare_analyse_failed());
      } finally {
        setLoading(false);
      }
    },
    [lapId, qualityStateKey],
  );

  const remove = useCallback(async () => {
    if (loading || deleting || !window.confirm(m.analysis_delete_lap_confirm())) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/laps/${lapId}/analyse`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSummary(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : m.compare_analyse_failed());
    } finally {
      setDeleting(false);
    }
  }, [deleting, lapId, loading, qualityStateKey]);

  useEffect(() => {
    if (panelOpen) void loadCached();
  }, [lapId, panelOpen, loadCached, qualityStateKey]);
  useEffect(() => {
    if (!panelOpen) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/laps/${lapId}/analyse/status`);
        const status = (await res.json()) as AnalysisStatus;
        if (cancelled) return;
        if (status.status === "active") {
          setLoading(true);
          timer = setTimeout(() => void poll(), 1500);
        } else {
          if (status.status === "failed") setError(status.error ?? m.compare_analyse_failed());
          if (status.status === "finished") await loadCached();
          setLoading(false);
        }
      } catch {
        if (!cancelled) timer = setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lapId, panelOpen, loadCached, qualityStateKey]);
  useEffect(() => {
    setSummary(null);
    setError(null);
  }, [lapId, qualityStateKey]);

  return { summary, loading, error, deleting, run, remove };
}

export function useInputsAnalysis(lapAId: number, lapBId: number, qualityStateKey: string, panelOpen: boolean) {
  const [analysis, setAnalysis] = useState<InputsAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const loadCached = useCallback(async () => {
    try {
      const res = await fetch(`/api/laps/${lapAId}/compare/${lapBId}/inputs-analyse?cacheOnly=true`, { method: "POST" });
      if (!res.ok) return;
      const data = (await res.json()) as { analysis: string | object | null; cached: boolean };
      if (!data.cached || !data.analysis) return;
      setAnalysis(typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis);
    } catch {
      /* cache probing is best-effort */
    }
  }, [lapAId, lapBId, qualityStateKey]);

  const run = useCallback(
    async (regenerate = false) => {
      setLoading(true);
      setError(null);
      try {
        const query = regenerate ? "?regenerate=true" : "";
        const res = await fetch(`/api/laps/${lapAId}/compare/${lapBId}/inputs-analyse${query}`, { method: "POST" });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({ error: m.compare_unknown_error() }))) as { error?: string };
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { analysis: string | object | null };
        if (!data.analysis) throw new Error(m.compare_analyse_inputs_failed());
        setAnalysis(typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : m.compare_analyse_inputs_failed());
      } finally {
        setLoading(false);
      }
    },
    [lapAId, lapBId, qualityStateKey],
  );

  const remove = useCallback(async () => {
    if (loading || deleting || !window.confirm(m.compare_delete_inputs_confirm())) return;
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch(`/api/laps/${lapAId}/compare/${lapBId}/inputs-analyse`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAnalysis(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : m.compare_analyse_inputs_failed());
    } finally {
      setDeleting(false);
    }
  }, [deleting, lapAId, lapBId, loading, qualityStateKey]);

  useEffect(() => {
    if (panelOpen) void loadCached();
  }, [panelOpen, loadCached, qualityStateKey]);
  useEffect(() => {
    if (!panelOpen) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/laps/${lapAId}/compare/${lapBId}/inputs-analyse/status`);
        const status = (await res.json()) as AnalysisStatus;
        if (cancelled) return;
        if (status.status === "active") {
          setLoading(true);
          timer = setTimeout(() => void poll(), 1500);
        } else {
          if (status.status === "failed") setError(status.error ?? m.compare_analyse_inputs_failed());
          if (status.status === "finished") await loadCached();
          setLoading(false);
        }
      } catch {
        if (!cancelled) timer = setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [lapAId, lapBId, panelOpen, loadCached, qualityStateKey]);
  useEffect(() => {
    setAnalysis(null);
    setError(null);
  }, [lapAId, lapBId, qualityStateKey]);

  return { analysis, loading, error, deleting, run, remove };
}

export function useAiRunAction(aiConfigured: boolean, run: (regenerate?: boolean) => Promise<void>, configureAi: () => void) {
  return useCallback((regenerate = false) => launchAiFeature(aiConfigured, () => void run(regenerate), configureAi), [aiConfigured, configureAi, run]);
}

export function useComparisonAiSettings() {
  const { displaySettings } = useSettings();
  return { aiConfigured: isAiAnalysisConfigured(displaySettings) };
}
