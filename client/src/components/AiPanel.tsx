import type { UIMessage } from "ai";
import { toPng } from "html-to-image";
import { Sparkles } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { m } from "@/paraglide/messages";
import { useSettings } from "../hooks/queries";
import { type ChatStreamError, type ChatStreamStatus, readChatStream } from "../lib/chat-stream";
import { isAiConfigured } from "../lib/is-ai-configured";
import { client } from "../lib/rpc";
import { resolveCssColor } from "../lib/rendering/css-values";
import { useUiStore } from "../stores/ui";
import { type AnalysisData, AnalysisDisplay, type AnalysisHighlight, findSegment, type Segment } from "./ai/analysis-display";
import { parseLapAnalysisForDisplay } from "./ai/analysis-display-data";
import { AnalysisModalShell, AnalysisResultCard, AnalysisSummaryRow } from "./ai/analysis-summary";
import { ChatPanel } from "./ai-chat/ChatPanel";
import { LapAnalysisText } from "./ai-chat/LapAnalysisText";
import { PanelSectionHeader } from "./ui/panel-section-header";
import { Button } from "./ui/button";

interface AnalysisUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
}

type StreamErrorEvent = ChatStreamError;

function formatStreamError(event: StreamErrorEvent): string {
  const parts = [event.message];
  const statusCode = typeof event.statusCode === "number" ? event.statusCode : event.upstream?.code;
  const status = event.upstream?.status;
  const model = event.modelId;
  if (statusCode || status) parts.push(`(${statusCode ?? "error"}${status ? ` ${status}` : ""})`);
  if (model) parts.push(`[${model}]`);
  if (event.retryable) parts.push(m.aipanel_retryable());
  return parts.join(" ");
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : m.aipanel_fetch_failed();
}
function safeParseAnalysis(raw: string): AnalysisData | null {
  const parsed = parseLapAnalysisForDisplay(raw);
  if (parsed) return parsed;

  console.error("[AiPanel] analysis JSON parse failed", {
    length: raw.length,
    around: raw.slice(0, 240),
    tail: raw.slice(Math.max(0, raw.length - 200)),
  });
  return null;
}

export type { AnalysisHighlight } from "./ai/analysis-display";

interface AiPanelProps {
  lapId: number;
  carName: string;
  trackName: string;
  segments?: { type: string; name: string; startFrac: number; endFrac: number }[] | null;
  onAnalysisLoaded?: () => void;
  onJumpToFrac?: (frac: number) => void;
  onHighlightsChange?: (highlights: AnalysisHighlight[]) => void;
  panelOpen?: boolean;
}

async function fetchLapChatHistory(lapId: number, gen?: number): Promise<UIMessage[]> {
  const url = gen === undefined ? `/api/laps/${lapId}/chat` : `/api/laps/${lapId}/chat?gen=${gen}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as { messages?: UIMessage[] };
  return (data.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant");
}

export interface AiPanelHandle {
  clearChat: () => void;
  clearAnalysis: () => void;
  clearAll: () => void;
}

// ── Main component ───────────────────────────────────────────

export const AiPanel = forwardRef<AiPanelHandle, AiPanelProps>(function AiPanel({ lapId, carName, trackName, segments, onAnalysisLoaded, onJumpToFrac, onHighlightsChange, panelOpen = false }, ref) {
  const { displaySettings } = useSettings();
  const openSettings = useUiStore((s) => s.openSettings);
  const aiConfigured = isAiConfigured(displaySettings);

  // Analysis state
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; model: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cornerFracs, setCornerFracs] = useState<Segment[]>([]);
  const analysisRef = useRef<HTMLDivElement>(null);

  // Same live-status pair for the analyse flow (separate from chat — chat now
  // lives in the shared ChatPanel component and streams via assistant-ui).
  const [analyseStatus, setAnalyseStatus] = useState<ChatStreamStatus | null>(null);
  const [analyseTool, setAnalyseTool] = useState<string | null>(null);
  const [chatRemountKey, setChatRemountKey] = useState(0);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [analysisCollapsed, setAnalysisCollapsed] = useState(false);
  const [analysisDeleting, setAnalysisDeleting] = useState(false);

  useImperativeHandle(
    ref,
    () => ({
      clearChat: () => {
        // Clear persisted chat only (keeps analysis), then remount ChatPanel
        // so it re-seeds from the now-empty thread.
        fetch(`/api/laps/${lapId}/chat?keepAnalysis=true`, { method: "DELETE" })
          .catch(() => {})
          .finally(() => setChatRemountKey((k) => k + 1));
      },
      clearAnalysis: () => {
        setAnalysis(null);
        setUsage(null);
        setError(null);
        onHighlightsChange?.([]);
        // DELETE clears both chat + analysis on server
        fetch(`/api/laps/${lapId}/chat`, { method: "DELETE" })
          .catch(() => {})
          .finally(() => setChatRemountKey((k) => k + 1));
      },
      clearAll: () => {
        setAnalysis(null);
        setUsage(null);
        setError(null);
        onHighlightsChange?.([]);
        fetch(`/api/laps/${lapId}/chat`, { method: "DELETE" })
          .catch(() => {})
          .finally(() => setChatRemountKey((k) => k + 1));
      },
    }),
    [lapId, onHighlightsChange],
  );

  // Fetch analysis.
  // Cached (incl. cacheOnly) responses stay JSON.
  // Fresh runs stream NDJSON (server/ai/chat-stream-style events) so the
  // UI can show "Thinking…" / tool-call chips / "Generating…" while the
  // model works — same protocol as the chat flow.
  const fetchAnalysis = useCallback(
    async (regenerate = false) => {
      setLoading(true);
      setError(null);
      setAnalyseStatus(null);
      setAnalyseTool(null);
      try {
        const res = await fetch(`/api/laps/${lapId}/analyse${regenerate ? "?regenerate=true" : ""}`, { method: "POST" });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({ error: m.aipanel_unknown_error() }))) as { error?: string };
          throw new Error(data.error || `HTTP ${res.status}`);
        }

        // Apply one analysis payload (analysis JSON + usage + cornerFracs) —
        // shared by cached-JSON and streamed-NDJSON code paths.
        const apply = (data: { analysis: string | object | null; usage?: AnalysisUsage; cornerFracs?: { label: string; startFrac: number; endFrac: number }[] }) => {
          // Empty string = model produced no text (e.g. it burned through
          // maxSteps calling tools without finalising). Treat as error.
          if (typeof data.analysis === "string" && data.analysis.trim().length === 0) {
            throw new Error(m.aipanel_no_text_error());
          }
          const parsed = (typeof data.analysis === "string" ? safeParseAnalysis(data.analysis) : data.analysis) as AnalysisData | null;
          setAnalysis(parsed);
          if (data.usage) setUsage(data.usage);
          if (data.cornerFracs) {
            setCornerFracs(
              data.cornerFracs.map((c) => ({
                type: "corner",
                name: c.label,
                startFrac: c.startFrac,
                endFrac: c.endFrac,
              })),
            );
          }
          const segs: Segment[] = data.cornerFracs
            ? data.cornerFracs.map((c) => ({ type: "corner", name: c.label, startFrac: c.startFrac, endFrac: c.endFrac }))
            : (segments ?? []);

          const searchSegs = segs.length ? segs : null;
          const hl: AnalysisHighlight[] = [];
          for (const corner of parsed?.corners ?? []) {
            const seg = findSegment(searchSegs, corner.name);
            if (seg) {
              hl.push({
                startFrac: seg.startFrac,
                endFrac: seg.endFrac,
                color: corner.severity === "major" ? "critical" : corner.severity === "moderate" ? "warning" : "good",
                label: corner.name,
              });
            }
          }
          for (const item of parsed?.braking ?? []) {
            const seg = findSegment(searchSegs, item.corner);
            if (seg) hl.push({ startFrac: seg.startFrac, endFrac: seg.endFrac, color: item.assessment, label: item.corner });
          }
          for (const item of parsed?.throttle ?? []) {
            const seg = findSegment(searchSegs, item.corner);
            if (seg) hl.push({ startFrac: seg.startFrac, endFrac: seg.endFrac, color: item.assessment, label: item.corner });
          }
          if (hl.length > 0) onHighlightsChange?.(hl);

          onAnalysisLoaded?.();
        };

        const ct = res.headers.get("content-type") ?? "";
        if (ct.includes("application/x-ndjson")) {
          // Heartbeat stream: server emits `ping` every ~200s to hold the
          // connection past Bun's 255s idleTimeout, then a single `result`
          // (or `error`) at the end. No intermediate UI.
          let resolved = false;
          await readChatStream(res, (event) => {
            switch (event.type) {
              case "ping":
              case "done":
                break;
              case "error": {
                const e = event as unknown as StreamErrorEvent;
                throw new Error(formatStreamError(e));
              }
              case "result": {
                const r = event as unknown as { analysis: string | object | null; usage?: AnalysisUsage; cornerFracs?: { label: string; startFrac: number; endFrac: number }[] };
                apply(r);
                resolved = true;
                break;
              }
            }
          });
          if (!resolved) throw new Error(m.aipanel_stream_no_result());
        } else {
          const data = (await res.json()) as { analysis: string | object | null; usage?: AnalysisUsage; cornerFracs?: { label: string; startFrac: number; endFrac: number }[] };
          apply(data);
        }
      } catch (err: unknown) {
        setError(toErrorMessage(err));
      } finally {
        setLoading(false);
        setAnalyseStatus(null);
        setAnalyseTool(null);
      }
    },
    [lapId, onAnalysisLoaded, segments, onHighlightsChange],
  );

  // Load cached analysis (no AI call — returns null if not cached)
  const loadCachedAnalysis = useCallback(async () => {
    try {
      const res = await client.api.laps[":id"].analyse.$post({
        param: { id: String(lapId) },
        query: { cacheOnly: "true" },
      });
      if (!res.ok) return;
      const data = (await res.json()) as {
        analysis: string | object | null;
        cached: boolean;
        usage?: { inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; model: string };
        cornerFracs?: { label: string; startFrac: number; endFrac: number }[];
      };
      if (!data.cached) return;
      const parsed = (typeof data.analysis === "string" ? safeParseAnalysis(data.analysis) : data.analysis) as AnalysisData | null;
      setAnalysis(parsed);
      if (data.usage) setUsage(data.usage);
      if (data.cornerFracs) {
        setCornerFracs(
          data.cornerFracs.map((c) => ({
            type: "corner" as const,
            name: c.label,
            startFrac: c.startFrac,
            endFrac: c.endFrac,
          })),
        );
      }
    } catch {
    }
  }, [lapId]);

  // Load cached analysis on open
  useEffect(() => {
    if (!panelOpen) return;
    loadCachedAnalysis();
  }, [lapId, panelOpen, loadCachedAnalysis]);
  useEffect(() => {
    if (!panelOpen) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      try {
        const res = await fetch(`/api/laps/${lapId}/analyse/status`);
        const status = (await res.json()) as { status?: "none" | "active" | "finished" | "failed"; error?: string };
        if (cancelled) return;
        if (status.status === "active") {
          setLoading(true);
          timer = setTimeout(() => void poll(), 1500);
        } else {
          if (status.status === "failed") setError(status.error ?? m.aipanel_unknown_error());
          if (status.status === "finished") await loadCachedAnalysis();
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
  }, [lapId, panelOpen, loadCachedAnalysis]);

  // Reset on lap change
  useEffect(() => {
    setAnalysis(null);
  }, [lapId]);

  // Export analysis as image
  const handleExport = useCallback(async () => {
    const el = analysisRef.current;
    if (!el) return;
    const origMaxH = el.style.maxHeight;
    const origOverflow = el.style.overflow;
    el.style.maxHeight = "none";
    el.style.overflow = "visible";
    try {
      const url = await toPng(el, { backgroundColor: resolveCssColor("var(--app-bg)"), pixelRatio: 2 });
      const link = document.createElement("a");
      link.download = `ai-analysis-${carName}-${trackName}.png`.replace(/\s+/g, "-");
      link.href = url;
      link.click();
    } catch (err) {
      console.error("[AI] Image export failed:", err);
    } finally {
      el.style.maxHeight = origMaxH;
      el.style.overflow = origOverflow;
    }
  }, [carName, trackName]);

  const clearChat = useCallback(() => {
    fetch(`/api/laps/${lapId}/chat?keepAnalysis=true`, { method: "DELETE" })
      .catch(() => {})
      .finally(() => setChatRemountKey((k) => k + 1));
  }, [lapId]);
  const deleteAnalysis = useCallback(async () => {
    if (analysisDeleting || loading || !window.confirm("Delete lap analysis? This cannot be undone.")) return;
    setAnalysisDeleting(true);
    try {
      const res = await fetch(`/api/laps/${lapId}/analyse`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setAnalysis(null);
      setUsage(null);
      setError(null);
      setAnalysisOpen(false);
      onHighlightsChange?.([]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete analysis");
    } finally {
      setAnalysisDeleting(false);
    }
  }, [analysisDeleting, lapId, loading, onHighlightsChange]);

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Analysis area. Once the chat is mounted below it this shrinks to its
          content — otherwise two flex-1 siblings would split the panel 50/50
          and the collapsed row would sit on top of a tall empty box. */}
      <div className={`overflow-y-auto px-3 py-3 space-y-2.5 ${analysis && !loading && !analysisCollapsed ? "shrink-0 max-h-[50%]" : !loading ? "shrink-0" : "flex-1 min-h-0"}`}>
        {analysis && !loading && (
          <PanelSectionHeader
            title="Lap analysis"
            collapsed={analysisCollapsed}
            onToggle={() => setAnalysisCollapsed((collapsed) => !collapsed)}
          />
        )}
        <div className={analysisCollapsed ? "hidden" : "contents"}>
          {/* No AI provider configured */}
          {!aiConfigured && (
            <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
              <Sparkles className="size-5 text-app-text-dim" />
              <div>
                <p className="text-app-compact text-app-text-secondary font-medium">{m.label_ai_not_set_up()}</p>
                <p className="text-app-caption text-app-text-muted mt-0.5">{m.aipanel_add_api_key()}</p>
              </div>
              <button
                type="button"
                onClick={() => openSettings("ai")}
                className="flex items-center gap-1.5 text-app-compact px-3 py-1.5 rounded bg-ai-accent hover:bg-ai-accent-hover text-app-on-filled font-medium transition-colors"
              >
                {m.aipanel_set_up_ai()}
              </button>
            </div>
          )}

          {/* Loading state */}
          {loading && (
            <div className="flex flex-col items-center py-10 gap-4">
              <div className="relative">
                <div className="size-10 border-2 border-app-border-input rounded-full" />
                <div className="absolute inset-0 size-10 border-2 border-transparent border-t-ai-accent rounded-full animate-spin" />
                <Sparkles className="absolute inset-0 m-auto size-4 text-ai-accent/60" />
              </div>
              <div className="text-center">
                <p className="text-app-compact text-app-text-secondary font-medium">
                  {analyseTool
                    ? `${m.aipanel_using_tool()} ${analyseTool}`
                    : analyseStatus === "generating"
                      ? m.aipanel_generating_analysis()
                      : analyseStatus === "thinking"
                        ? m.aipanel_thinking()
                        : m.aipanel_preparing_model()}
                </p>
                <p className="text-app-caption text-app-text-dim mt-1">{analyseStatus === "generating" ? m.aipanel_streaming_tokens() : m.aipanel_reviewing_data()}</p>
                {!analyseStatus && <p className="text-app-micro text-app-text-dim mt-0.5">{m.aipanel_may_take()}</p>}
              </div>
              <div className="flex gap-1">
                <div className="size-1 rounded-full bg-ai-accent animate-pulse" />
                <div className="size-1 rounded-full bg-ai-accent animate-pulse [animation-delay:200ms]" />
                <div className="size-1 rounded-full bg-ai-accent animate-pulse [animation-delay:400ms]" />
              </div>
            </div>
          )}

          {/* Empty state — after clear */}
          {aiConfigured && !analysis && !loading && !error && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Sparkles className="size-5 text-ai-accent" />
              <p className="text-app-compact text-app-text-muted">{m.aipanel_no_analysis()}</p>
              <button
                type="button"
                onClick={() => fetchAnalysis(false)}
                className="flex items-center gap-1.5 text-app-compact px-3 py-1.5 rounded bg-app-accent hover:bg-app-accent-hover text-app-on-filled transition-colors"
              >
                <Sparkles className="size-3" />
                {m.aipanel_analyse_lap()}
              </button>
            </div>
          )}

          {/* Error state */}
          {error && !loading && (
            <div className="flex justify-start">
              <div className="rounded-lg px-2.5 py-2 bg-status-danger/10 border border-status-danger/20">
                <p className="text-app-compact text-status-danger">{error}</p>
                <Button variant="app-outline" size="app-sm" onClick={() => fetchAnalysis(false)} className="mt-1">
                  {m.label_retry()}
                </Button>
              </div>
            </div>
          )}

          {/* Analysis collapses to a summary row; the full breakdown opens in a
            modal. Both pieces are the shared components the compare panel
            uses, so the two pages stay in lockstep. */}
          {analysis && !loading && (
            <AnalysisResultCard
              title={trackName || "Lap analysis"}
              dotClass="bg-app-accent"
              hasResult
              loading={false}
              error={null}
              runLabel={m.aipanel_analyse_lap()}
              loadingLabel={m.common_loading()}
              retryLabel={m.label_retry()}
              onRun={() => void fetchAnalysis(false)}
              onRetry={() => void fetchAnalysis(false)}
              onRegenerate={() => void fetchAnalysis(true)}
              onDelete={() => void deleteAnalysis()}
              deleteLabel={m.label_clear()}
              actionsDisabled={analysisDeleting}
            >
              <AnalysisSummaryRow
                detail={`${analysis.corners?.length ?? 0} corners · ${analysis.coaching?.length ?? 0} tips`}
                onView={() => setAnalysisOpen(true)}
              />
            </AnalysisResultCard>
          )}

          {analysis && !loading && analysisOpen && (
            <AnalysisModalShell
              subtitle={[carName, trackName].filter(Boolean).join(" · ") || undefined}
              onClose={() => setAnalysisOpen(false)}
            >
              <AnalysisDisplay
                analysis={analysis}
                cornerFracs={cornerFracs}
                segments={segments}
                usage={usage}
                loading={loading || analysisDeleting}
                containerRef={analysisRef}
                onJumpToFrac={onJumpToFrac}
                onHighlightsChange={onHighlightsChange}
                onExport={handleExport}
                onRegenerate={() => {
                  clearChat();
                  fetchAnalysis(true);
                }}
                onClear={deleteAnalysis}
              />
            </AnalysisModalShell>
          )}
        </div>
      </div>

      {analysis && !loading && (
        <div className="flex-1 min-h-0 flex flex-col border-t border-app-border">
          <ChatPanel
            key={chatRemountKey}
            api={`/api/laps/${lapId}/chat`}
            clearChatApi={`/api/laps/${lapId}/chat?keepAnalysis=true`}
            fetchHistory={(gen) => fetchLapChatHistory(lapId, gen)}
            historyQueryKey={["lap-chat-history", lapId, chatRemountKey]}
            remountKey={`${lapId}:${chatRemountKey}`}
            compactThreadId={`lap-${lapId}`}
            components={{ Text: LapAnalysisText }}
          />
        </div>
      )}
    </div>
  );
});
