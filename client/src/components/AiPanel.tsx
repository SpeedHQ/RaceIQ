import { toPng } from "html-to-image";
import { Sparkles } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { m } from "@/paraglide/messages";
import { useSettings } from "../hooks/queries";
import { type ChatStreamError, type ChatStreamStatus, readChatStream } from "../lib/chat-stream";
import { fetchChatHistory } from "../lib/chat-history";
import { isAiAnalysisConfigured, launchAiFeature } from "../lib/is-ai-configured";
import { resolveCssColor } from "../lib/rendering/css-values";
import { client } from "../lib/rpc";
import { useUiStore } from "../stores/ui";
import { type AnalysisData, AnalysisDisplay, type AnalysisHighlight, findSegment, type Segment, SetupList } from "./ai/analysis-display";
import { AnalysisModalShell, AnalysisSummaryRow } from "./ai/analysis-summary";
import { ChatPanel } from "./ai-chat/ChatPanel";
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
function safeParseAnalysis(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const posMatch = msg.match(/position (\d+)/);
    const pos = posMatch ? Number(posMatch[1]) : -1;
    const windowStart = pos >= 0 ? Math.max(0, pos - 120) : 0;
    const windowEnd = pos >= 0 ? Math.min(raw.length, pos + 120) : Math.min(raw.length, 240);
    console.error("[AiPanel] analysis JSON parse failed", {
      length: raw.length,
      position: pos,
      around: raw.slice(windowStart, windowEnd),
      tail: raw.slice(Math.max(0, raw.length - 200)),
    });
    throw err;
  }
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

async function fetchLapChatHistory(lapId: number, gen?: number) {
  return fetchChatHistory(`/api/laps/${lapId}/chat`, gen);
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
  const aiConfigured = isAiAnalysisConfigured(displaySettings);

  // Analysis state
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; model: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cornerFracs, setCornerFracs] = useState<Segment[]>([]);
  const [hasTune, setHasTune] = useState(false);
  const analysisRef = useRef<HTMLDivElement>(null);

  // Same live-status pair for the analyse flow (separate from chat — chat now
  // lives in the shared ChatPanel component and streams via assistant-ui).
  const [analyseStatus, setAnalyseStatus] = useState<ChatStreamStatus | null>(null);
  const [analyseTool, setAnalyseTool] = useState<string | null>(null);
  const [chatRemountKey, setChatRemountKey] = useState(0);
  const [analysisOpen, setAnalysisOpen] = useState(false);
  const [modalTab, setModalTab] = useState("analysis");

  useImperativeHandle(
    ref,
    () => ({
      clearChat: () => {
        // Clear persisted chat only (keeps analysis), then remount ChatPanel
        // so it re-seeds from the now-empty thread.
        fetch(`/api/laps/${lapId}/chat`, { method: "DELETE" })
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

        // Apply one analysis payload (analysis JSON + usage + cornerFracs +
        // hasTune) — shared by the cached-JSON and streamed-NDJSON code paths.
        const apply = (data: { analysis: string | object | null; usage?: AnalysisUsage; cornerFracs?: { label: string; startFrac: number; endFrac: number }[]; hasTune?: boolean }) => {
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
          setHasTune(!!data.hasTune);

          const segs: Segment[] = data.cornerFracs ? data.cornerFracs.map((c) => ({ type: "corner", name: c.label, startFrac: c.startFrac, endFrac: c.endFrac })) : (segments ?? []);
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
                const r = event as unknown as { analysis: string | object | null; usage?: AnalysisUsage; cornerFracs?: { label: string; startFrac: number; endFrac: number }[]; hasTune?: boolean };
                apply(r);
                resolved = true;
                break;
              }
            }
          });
          if (!resolved) throw new Error(m.aipanel_stream_no_result());
        } else {
          const data = (await res.json()) as { analysis: string | object | null; usage?: AnalysisUsage; cornerFracs?: { label: string; startFrac: number; endFrac: number }[]; hasTune?: boolean };
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
        hasTune?: boolean;
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
      setHasTune(!!data.hasTune);
    } catch {
      /* ignore */
    }
  }, [lapId]);

  // Load cached analysis on open
  useEffect(() => {
    if (!panelOpen) return;
    loadCachedAnalysis();
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
      const url = await toPng(el, { backgroundColor: resolveCssColor("var(--app-surface)"), pixelRatio: 2 });
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
    fetch(`/api/laps/${lapId}/chat`, { method: "DELETE" })
      .catch(() => {})
      .finally(() => setChatRemountKey((k) => k + 1));
  }, [lapId]);

  const configureAi = useCallback(() => openSettings("ai"), [openSettings]);
  const runAnalysis = useCallback(
    (regenerate = false) => launchAiFeature(aiConfigured, () => void fetchAnalysis(regenerate), configureAi),
    [aiConfigured, configureAi, fetchAnalysis],
  );
  const regenerateAnalysis = useCallback(
    () =>
      launchAiFeature(
        aiConfigured,
        () => {
          clearChat();
          void fetchAnalysis(true);
        },
        configureAi,
      ),
    [aiConfigured, clearChat, configureAi, fetchAnalysis],
  );

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Analysis area. Once the chat is mounted below it this shrinks to its
          content — otherwise two flex-1 siblings would split the panel 50/50
          and the collapsed row would sit on top of a tall empty box. */}
      <div className={`overflow-y-auto px-3 py-3 space-y-2.5 ${analysis && !loading ? "shrink-0 max-h-[50%]" : "flex-1 min-h-0"}`}>
        {/* No AI provider configured */}
        {!aiConfigured && (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <Sparkles className="size-5 text-app-text-dim" />
            <div>
              <p className="text-app-compact text-app-text-secondary font-medium">{m.label_ai_not_set_up()}</p>
              <p className="text-app-caption text-app-text-muted mt-0.5">{m.ai_configure_feature_description()}</p>
            </div>
            <Button variant="app-primary" size="app-md" onClick={() => openSettings("ai")}>
              {m.ai_configure_feature()}
            </Button>
          </div>
        )}

        {/* Loading state */}
        {loading && (
          <div className="flex flex-col items-center py-10 gap-4">
            <div className="relative">
              <div className="size-10 border-2 border-app-border-input rounded-full" />
              <div className="absolute inset-0 size-10 border-2 border-transparent rounded-full animate-spin" style={{ borderTopColor: "var(--ai-accent)" }} />
              <Sparkles className="absolute inset-0 m-auto size-4 text-(--ai-accent)/60" />
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
              <div className="size-1 rounded-full animate-pulse" style={{ backgroundColor: "var(--ai-accent)" }} />
              <div className="size-1 rounded-full animate-pulse [animation-delay:200ms]" style={{ backgroundColor: "var(--ai-accent)" }} />
              <div className="size-1 rounded-full animate-pulse [animation-delay:400ms]" style={{ backgroundColor: "var(--ai-accent)" }} />
            </div>
          </div>
        )}

        {/* Empty state — after clear */}
        {aiConfigured && !analysis && !loading && !error && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Sparkles className="size-5" style={{ color: "var(--ai-accent)" }} />
            <p className="text-app-compact text-app-text-muted">{m.aipanel_no_analysis()}</p>
            <Button variant="app-primary" size="app-md" onClick={() => runAnalysis(false)} className="text-app-compact">
              <Sparkles className="size-3" />
              {m.aipanel_analyse_lap()}
            </Button>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="flex justify-start">
            <div className="rounded-lg px-2.5 py-2 bg-status-danger/10 border border-status-danger/20">
              <p className="text-app-compact text-status-danger">{error}</p>
              <Button variant={aiConfigured ? "app-outline" : "app-primary"} size="app-sm" onClick={() => runAnalysis(false)} className="mt-1">
                {aiConfigured ? m.label_retry() : m.ai_configure_feature()}
              </Button>
            </div>
          </div>
        )}

        {/* Analysis collapses to a summary row; the full breakdown opens in a
            modal. Both pieces are the shared components the compare panel
            uses, so the two pages stay in lockstep. */}
        {analysis && !loading && (
          <AnalysisSummaryRow
            detail={`${analysis.corners?.length ?? 0} corners · ${analysis.coaching?.length ?? 0} tips · ${analysis.setup?.length ?? 0} setup`}
            onView={() => setAnalysisOpen(true)}
          />
        )}

        {analysis && !loading && analysisOpen && (
          <AnalysisModalShell
            subtitle={[carName, trackName].filter(Boolean).join(" · ") || undefined}
            onClose={() => setAnalysisOpen(false)}
            tabs={[
              { key: "analysis", label: m.label_ai_analysis() },
              ...(analysis.setup?.length ? [{ key: "setup", label: m.aidisplay_setup(), badge: analysis.setup.length, flag: hasTune ? undefined : m.aidisplay_best_guess() }] : []),
            ]}
            activeTab={modalTab}
            onTabChange={setModalTab}
          >
            {modalTab === "setup" ? (
              <SetupList
                setup={analysis.setup}
                hasTune={hasTune}
                lookupSegs={cornerFracs.length ? cornerFracs : (segments ?? null)}
                onJumpToFrac={onJumpToFrac}
                onHighlightsChange={onHighlightsChange}
              />
            ) : (
              <AnalysisDisplay
                analysis={analysis}
                cornerFracs={cornerFracs}
                segments={segments}
                usage={usage}
                loading={loading}
                containerRef={analysisRef}
                onJumpToFrac={onJumpToFrac}
                onHighlightsChange={onHighlightsChange}
                onExport={handleExport}
                onRegenerate={regenerateAnalysis}
                onClear={() => {
                  clearChat();
                  setAnalysis(null);
                  setUsage(null);
                  setAnalysisOpen(false);
                  onHighlightsChange?.([]);
                }}
              />
            )}
          </AnalysisModalShell>
        )}
      </div>

      {!loading && analysis && (
        <div className="flex-1 min-h-0 flex flex-col border-t border-app-border">
          <ChatPanel
            key={chatRemountKey}
            api={`/api/laps/${lapId}/chat`}
            fetchHistory={(gen) => fetchLapChatHistory(lapId, gen)}
            historyQueryKey={["lap-chat-history", lapId, chatRemountKey]}
            remountKey={`${lapId}:${chatRemountKey}`}
            compactThreadId={`lap-${lapId}`}
          />
        </div>
      )}
    </div>
  );
});
