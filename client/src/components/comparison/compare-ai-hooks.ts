import { useCallback, useEffect, useRef, useState } from "react";
import type { GameId } from "@shared/games/ids";
import { useSettings } from "@/hooks/settings";
import { type ChatStreamError, readChatStream } from "@/lib/chat-stream";
import { isAiAnalysisConfigured, launchAiFeature } from "@/lib/is-ai-configured";
import { client } from "@/lib/rpc";
import { rpcJson } from "@/lib/rpc-json";
import { m } from "@/paraglide/messages";
import { type AnalysisSummary, type InputsAnalysis, summarize } from "./compare-ai-types";

function formatAnalysisStreamError(event: ChatStreamError): string {
  const statusCode = typeof event.statusCode === "number" ? event.statusCode : event.upstream?.code;
  const status = event.upstream?.status;
  return `${event.message}${statusCode || status ? ` (${statusCode ?? "error"}${status ? ` ${status}` : ""})` : ""}`;
}

type AnalysisStatus = { status?: "none" | "active" | "finished" | "failed"; error?: string };
const MAX_BACKFILL_POLLS = 20;
const BACKFILL_POLL_MS = 1500;

async function requestAfterFindingBackfill(request: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; attempt <= MAX_BACKFILL_POLLS; attempt += 1) {
    const response = await request();
    if (response.status !== 409) return response;
    const body = await response.clone().json().catch(() => null) as { status?: string; retryable?: boolean } | null;
    if (body?.status !== "backfilling" || body.retryable !== true || attempt === MAX_BACKFILL_POLLS) return response;
    await new Promise<void>((resolve) => window.setTimeout(resolve, BACKFILL_POLL_MS));
  }
  throw new Error(m.compare_analyse_failed());
}

export function useLapAnalysis(lapId: number, gameId: GameId, qualityStateKey: string, panelOpen: boolean) {
  const [summary, setSummary] = useState<AnalysisSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const runSequence = useRef(0);
  const cacheSequence = useRef(0);
  const deleteSequence = useRef(0);
  const headers = { "X-Game-Id": gameId };

  const loadCached = useCallback(async (isCurrent: () => boolean = () => true) => {
    const sequence = ++cacheSequence.current;
    try {
      const data = await rpcJson<{ analysis: string | object | null; cached: boolean }>(
        await requestAfterFindingBackfill(() => client.api.laps[":id"].analyse.$post({ param: { id: String(lapId) }, query: { cacheOnly: "true" } }, { headers })),
      );
      if (!data.cached || !data.analysis || cacheSequence.current !== sequence || !isCurrent()) return;
      setSummary(summarize(typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis));
    } catch {
      /* cache probing is best-effort */
    }
  }, [gameId, lapId, qualityStateKey]);

  const run = useCallback(
    async (regenerate = false) => {
      const sequence = ++runSequence.current;
      cacheSequence.current += 1;
      setLoading(true);
      setError(null);
      try {
        const res = await requestAfterFindingBackfill(() => client.api.laps[":id"].analyse.$post(
          { param: { id: String(lapId) }, query: regenerate ? { regenerate: "true" } : {} },
          { headers },
        ));
        if (!res.ok) throw new Error(m.compare_unknown_error());
        if ((res.headers.get("content-type") ?? "").includes("application/x-ndjson")) {
          let resolved = false;
          await readChatStream(res, (event) => {
            if (event.type === "error") throw new Error(formatAnalysisStreamError(event as ChatStreamError));
            if (event.type !== "result") return;
            const result = event as { analysis?: string | object | null };
            if (!result.analysis) throw new Error(m.compare_analyse_failed());
            resolved = true;
            if (runSequence.current === sequence) {
              setSummary(summarize(typeof result.analysis === "string" ? JSON.parse(result.analysis) : result.analysis));
            }
          });
          if (runSequence.current !== sequence) return;
          if (!resolved) throw new Error(m.compare_analyse_failed());
        } else {
          const data = await rpcJson<{ analysis: string | object | null; error?: string }>(res);
          if (runSequence.current !== sequence) return;
          if (data.error || !data.analysis) throw new Error(data.error || m.compare_analyse_failed());
          setSummary(summarize(typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis));
        }
      } catch (err: unknown) {
        if (runSequence.current === sequence) setError(err instanceof Error ? err.message : m.compare_analyse_failed());
      } finally {
        if (runSequence.current === sequence) setLoading(false);
      }
    },
    [gameId, lapId, qualityStateKey],
  );

  const remove = useCallback(async () => {
    if (loading || deleting || !window.confirm(m.analysis_delete_lap_confirm())) return;
    const sequence = ++deleteSequence.current;
    runSequence.current += 1;
    cacheSequence.current += 1;
    setDeleting(true);
    setError(null);
    try {
      await rpcJson<{ ok: true }>(await client.api.laps[":id"].analyse.$delete({ param: { id: String(lapId) } }, { headers }));
      if (deleteSequence.current === sequence) setSummary(null);
    } catch (err) {
      if (deleteSequence.current === sequence) setError(err instanceof Error ? err.message : m.compare_analyse_failed());
    } finally {
      if (deleteSequence.current === sequence) setDeleting(false);
    }
  }, [deleting, gameId, lapId, loading, qualityStateKey]);

  useEffect(() => {
    runSequence.current += 1;
    cacheSequence.current += 1;
    deleteSequence.current += 1;
    setSummary(null);
    setError(null);
  }, [lapId, qualityStateKey]);
  useEffect(() => {
    if (!panelOpen) return;
    let cancelled = false;
    void loadCached(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [lapId, panelOpen, loadCached, qualityStateKey]);
  useEffect(() => {
    if (!panelOpen) return;
    let cancelled = false;
    const pollRunSequence = runSequence.current;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const status = await rpcJson<AnalysisStatus>(
          await client.api.laps[":id"].analyse.status.$get({ param: { id: String(lapId) } }, { headers }),
        );
        if (cancelled || runSequence.current !== pollRunSequence) return;
        if (status.status === "active") {
          setLoading(true);
          timer = window.setTimeout(() => void poll(), BACKFILL_POLL_MS);
        } else {
          if (status.status === "failed") setError(status.error ?? m.compare_analyse_failed());
          if (status.status === "finished") await loadCached(() => !cancelled);
          if (cancelled || runSequence.current !== pollRunSequence) return;
          setLoading(false);
        }
      } catch {
        if (!cancelled && runSequence.current === pollRunSequence) timer = window.setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [gameId, lapId, panelOpen, loadCached, qualityStateKey]);
  return { summary, loading, error, deleting, run, remove };
}

export function useInputsAnalysis(lapAId: number, lapBId: number, gameId: GameId, qualityStateKey: string, panelOpen: boolean) {
  const [analysis, setAnalysis] = useState<InputsAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const runSequence = useRef(0);
  const cacheSequence = useRef(0);
  const deleteSequence = useRef(0);
  const headers = { "X-Game-Id": gameId };
  const loadCached = useCallback(async (isCurrent: () => boolean = () => true) => {
    const sequence = ++cacheSequence.current;
    try {
      const data = await rpcJson<{ analysis: string | object | null; cached: boolean }>(
        await requestAfterFindingBackfill(() => client.api.laps[":id1"].compare[":id2"]["inputs-analyse"].$post(
          { param: { id1: String(lapAId), id2: String(lapBId) }, query: { cacheOnly: "true" } },
          { headers },
        )),
      );
      if (!data.cached || !data.analysis || cacheSequence.current !== sequence || !isCurrent()) return;
      setAnalysis(typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis);
    } catch {
      /* cache probing is best-effort */
    }
  }, [gameId, lapAId, lapBId, qualityStateKey]);

  const run = useCallback(
    async (regenerate = false) => {
      const sequence = ++runSequence.current;
      cacheSequence.current += 1;
      setLoading(true);
      setError(null);
      try {
        const data = await rpcJson<{ analysis: string | object | null }>(
          await requestAfterFindingBackfill(() => client.api.laps[":id1"].compare[":id2"]["inputs-analyse"].$post(
            { param: { id1: String(lapAId), id2: String(lapBId) }, query: regenerate ? { regenerate: "true" } : {} },
            { headers },
          )),
        );
        if (runSequence.current !== sequence) return;
        if (!data.analysis) throw new Error(m.compare_analyse_inputs_failed());
        setAnalysis(typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis);
      } catch (err: unknown) {
        if (runSequence.current === sequence) setError(err instanceof Error ? err.message : m.compare_analyse_inputs_failed());
      } finally {
        if (runSequence.current === sequence) setLoading(false);
      }
    },
    [gameId, lapAId, lapBId, qualityStateKey],
  );
  const remove = useCallback(async () => {
    if (loading || deleting || !window.confirm(m.compare_delete_inputs_confirm())) return;
    const sequence = ++deleteSequence.current;
    runSequence.current += 1;
    cacheSequence.current += 1;
    setDeleting(true);
    setError(null);
    try {
      await rpcJson<{ ok: true }>(
        await client.api.laps[":id1"].compare[":id2"]["inputs-analyse"].$delete(
          { param: { id1: String(lapAId), id2: String(lapBId) } },
          { headers },
        ),
      );
      if (deleteSequence.current === sequence) setAnalysis(null);
    } catch (err) {
      if (deleteSequence.current === sequence) setError(err instanceof Error ? err.message : m.compare_analyse_inputs_failed());
    } finally {
      if (deleteSequence.current === sequence) setDeleting(false);
    }
  }, [deleting, gameId, lapAId, lapBId, loading, qualityStateKey]);

  useEffect(() => {
    runSequence.current += 1;
    cacheSequence.current += 1;
    deleteSequence.current += 1;
    setAnalysis(null);
    setError(null);
  }, [lapAId, lapBId, qualityStateKey]);
  useEffect(() => {
    if (!panelOpen) return;
    let cancelled = false;
    void loadCached(() => !cancelled);
    return () => {
      cancelled = true;
    };
  }, [panelOpen, loadCached, qualityStateKey]);
  useEffect(() => {
    if (!panelOpen) return;
    let cancelled = false;
    const pollRunSequence = runSequence.current;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const status = await rpcJson<AnalysisStatus>(
          await client.api.laps[":id1"].compare[":id2"]["inputs-analyse"].status.$get(
            { param: { id1: String(lapAId), id2: String(lapBId) } },
            { headers },
          ),
        );
        if (cancelled || runSequence.current !== pollRunSequence) return;
        if (status.status === "active") {
          setLoading(true);
          timer = window.setTimeout(() => void poll(), BACKFILL_POLL_MS);
        } else {
          if (status.status === "failed") setError(status.error ?? m.compare_analyse_inputs_failed());
          if (status.status === "finished") await loadCached(() => !cancelled);
          if (cancelled || runSequence.current !== pollRunSequence) return;
          setLoading(false);
        }
      } catch {
        if (!cancelled && runSequence.current === pollRunSequence) timer = window.setTimeout(() => void poll(), 3000);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [gameId, lapAId, lapBId, panelOpen, loadCached, qualityStateKey]);
  return { analysis, loading, error, deleting, run, remove };
}

export function useAiRunAction(aiConfigured: boolean, run: (regenerate?: boolean) => Promise<void>, configureAi: () => void) {
  return useCallback((regenerate = false) => launchAiFeature(aiConfigured, () => void run(regenerate), configureAi), [aiConfigured, configureAi, run]);
}

export function useComparisonAiSettings() {
  const { displaySettings } = useSettings();
  return { aiConfigured: isAiAnalysisConfigured(displaySettings) };
}
