import type { UIMessage } from "ai";
import { toPng } from "html-to-image";
import { AlertTriangle, CircleDot, Download, Gauge, Lightbulb, RefreshCw, Sliders, Sparkles, Trash2, Zap } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { m } from "@/paraglide/messages";
import { useSettings } from "../hooks/queries";
import { type ChatStreamError, type ChatStreamStatus, readChatStream } from "../lib/chat-stream";
import { isAiConfigured } from "../lib/is-ai-configured";
import { client } from "../lib/rpc";
import { useUiStore } from "../stores/ui";
import { SetupSection } from "./ai/analysis-display";
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

export interface AnalysisHighlight {
  startFrac: number;
  endFrac: number;
  color: "good" | "warning" | "critical";
  label: string;
}

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

// ── Analysis types ───────────────────────────────────────────

interface PaceItem {
  label: string;
  value: string;
  assessment: "good" | "warning" | "critical";
  detail: string;
}
interface HandlingItem {
  label: string;
  value: string;
  assessment: "good" | "warning" | "critical";
  detail: string;
}
interface CornerItem {
  name: string;
  issue: string;
  fix: string;
  severity: "minor" | "moderate" | "major";
}
interface CornerBrakingItem {
  corner: string;
  assessment: "good" | "warning" | "critical";
  brakePoint: string;
  detail: string;
}
interface CornerThrottleItem {
  corner: string;
  assessment: "good" | "warning" | "critical";
  throttlePoint: string;
  detail: string;
}
interface CoachingItem {
  tip: string;
  detail: string;
}
interface SetupItem {
  component: string;
  symptom: string;
  fix: string;
  current: string;
  target: string;
  direction: "increase" | "decrease" | "adjust";
}

interface AnalysisData {
  verdict: string;
  pace: PaceItem[];
  handling: HandlingItem[];
  corners: CornerItem[];
  braking: CornerBrakingItem[];
  throttle: CornerThrottleItem[];
  coaching: CoachingItem[];
  setup: SetupItem[];
}

const ASSESSMENT_COLORS = { good: "text-emerald-400", warning: "text-amber-400", critical: "text-red-400" };
const ASSESSMENT_BG = { good: "bg-emerald-400/10 border-emerald-400/20", warning: "bg-amber-400/10 border-amber-400/20", critical: "bg-red-400/10 border-red-400/20" };
const SEVERITY_COLORS = { minor: "bg-app-text-dim", moderate: "bg-amber-500", major: "bg-red-500" };

function MetricCard({ item }: { item: PaceItem | HandlingItem }) {
  return (
    <div className={`rounded-lg border px-2.5 py-1.5 ${ASSESSMENT_BG[item.assessment]}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] text-app-text-secondary uppercase tracking-wide">{item.label}</span>
        <span className={`text-[11px] font-mono font-semibold ${ASSESSMENT_COLORS[item.assessment]}`}>{item.value}</span>
      </div>
      <p className="text-[10px] text-app-text-secondary mt-0.5 leading-relaxed">{item.detail}</p>
    </div>
  );
}

type Segment = { type: string; name: string; startFrac: number; endFrac: number };

/** Find a segment whose name matches any of the search strings. */
function findSegment(segments: Segment[] | null | undefined, ...texts: string[]): Segment | null {
  if (!segments || segments.length === 0) return null;
  const combined = texts.join(" ").toLowerCase();
  // Exact substring match first
  for (const s of segments) {
    const sn = s.name.toLowerCase();
    if (combined.includes(sn) || sn.includes(combined)) return s;
  }
  // Word-level fuzzy: any word > 2 chars appears in segment name
  const words = combined.split(/\s+/).filter((w) => w.length > 2);
  for (const s of segments) {
    const sn = s.name.toLowerCase();
    if (words.some((w) => sn.includes(w))) return s;
  }
  return null;
}

/** Wrapper that makes a card clickable to highlight a track zone. */
function TrackCard({
  seg,
  color,
  onJumpToFrac,
  onHighlightsChange,
  className,
  children,
}: {
  seg: Segment | null;
  color: "good" | "warning" | "critical";
  onJumpToFrac?: (frac: number) => void;
  onHighlightsChange?: (h: AnalysisHighlight[]) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const clickable = !!(seg && onJumpToFrac);
  const activate = () => {
    if (!seg) return;
    onJumpToFrac?.((seg.startFrac + seg.endFrac) / 2);
    onHighlightsChange?.([{ startFrac: seg.startFrac, endFrac: seg.endFrac, color, label: seg.name }]);
  };
  return (
    <div
      className={`${className ?? ""} ${clickable ? "cursor-pointer hover:brightness-110 transition" : ""}`}
      {...(clickable
        ? {
            role: "button" as const,
            tabIndex: 0,
            onClick: activate,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                activate();
              }
            },
          }
        : {})}
    >
      {children}
    </div>
  );
}

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-2">
      <span className="text-app-text-secondary">{icon}</span>
      <h3 className="text-[10px] font-semibold text-app-text uppercase tracking-wider">{title}</h3>
    </div>
  );
}

async function fetchLapChatHistory(lapId: number): Promise<UIMessage[]> {
  const res = await fetch(`/api/laps/${lapId}/chat`);
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
  const [hasTune, setHasTune] = useState(false);
  const analysisRef = useRef<HTMLDivElement>(null);

  // Same live-status pair for the analyse flow (separate from chat — chat now
  // lives in the shared ChatPanel component and streams via assistant-ui).
  const [analyseStatus, setAnalyseStatus] = useState<ChatStreamStatus | null>(null);
  const [analyseTool, setAnalyseTool] = useState<string | null>(null);
  const [chatRemountKey, setChatRemountKey] = useState(0);

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
      const url = await toPng(el, { backgroundColor: "#0f172a", pixelRatio: 2 });
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

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Unified conversation */}
      <div className="flex-1 overflow-y-auto min-h-0 px-3 py-3 space-y-2.5">
        {/* No AI provider configured */}
        {!aiConfigured && (
          <div className="flex flex-col items-center justify-center py-12 gap-3 text-center">
            <Sparkles className="size-5 text-app-text-dim" />
            <div>
              <p className="text-[11px] text-app-text-secondary font-medium">{m.label_ai_not_set_up()}</p>
              <p className="text-[10px] text-app-text-muted mt-0.5">{m.aipanel_add_api_key()}</p>
            </div>
            <button
              type="button"
              onClick={() => openSettings("ai")}
              className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-black font-medium transition-colors"
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
              <div className="absolute inset-0 size-10 border-2 border-transparent border-t-amber-400 rounded-full animate-spin" />
              <Sparkles className="absolute inset-0 m-auto size-4 text-amber-400/60" />
            </div>
            <div className="text-center">
              <p className="text-[11px] text-app-text-secondary font-medium">
                {analyseTool
                  ? `${m.aipanel_using_tool()} ${analyseTool}`
                  : analyseStatus === "generating"
                    ? m.aipanel_generating_analysis()
                    : analyseStatus === "thinking"
                      ? m.aipanel_thinking()
                      : m.aipanel_preparing_model()}
              </p>
              <p className="text-[10px] text-app-text-dim mt-1">{analyseStatus === "generating" ? m.aipanel_streaming_tokens() : m.aipanel_reviewing_data()}</p>
              {!analyseStatus && <p className="text-[9px] text-app-text-dim mt-0.5">{m.aipanel_may_take()}</p>}
            </div>
            <div className="flex gap-1">
              <div className="size-1 rounded-full bg-amber-400 animate-pulse" />
              <div className="size-1 rounded-full bg-amber-400 animate-pulse [animation-delay:200ms]" />
              <div className="size-1 rounded-full bg-amber-400 animate-pulse [animation-delay:400ms]" />
            </div>
          </div>
        )}

        {/* Empty state — after clear */}
        {aiConfigured && !analysis && !loading && !error && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Sparkles className="size-5 text-amber-400" />
            <p className="text-[11px] text-app-text-muted">{m.aipanel_no_analysis()}</p>
            <button type="button" onClick={() => fetchAnalysis(false)} className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white transition-colors">
              <Sparkles className="size-3" />
              {m.aipanel_analyse_lap()}
            </button>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="flex justify-start">
            <div className="rounded-lg px-2.5 py-2 bg-red-400/10 border border-red-400/20">
              <p className="text-[11px] text-red-400">{error}</p>
              <Button variant="app-outline" size="app-sm" onClick={() => fetchAnalysis(false)} className="mt-1">
                {m.label_retry()}
              </Button>
            </div>
          </div>
        )}

        {/* Analysis as first assistant message (structured cards) */}
        {analysis && !loading && (
          <div ref={analysisRef} className="flex justify-start">
            <div className="max-w-full rounded-lg px-2.5 py-2 bg-app-surface-alt/60 border border-app-border-input/40 text-app-text-secondary space-y-3">
              {/* Verdict */}
              <p className="text-[11px] text-app-text leading-relaxed">{analysis.verdict}</p>

              {/* Pace */}
              {analysis.pace?.length > 0 && (
                <div>
                  <SectionHeader icon={<Gauge className="size-3" />} title={m.label_pace()} />
                  <div className="grid grid-cols-1 gap-1.5">
                    {analysis.pace.map((item) => (
                      <MetricCard key={item.label} item={item} />
                    ))}
                  </div>
                </div>
              )}

              {/* Handling */}
              {analysis.handling?.length > 0 && (
                <div>
                  <SectionHeader icon={<Sliders className="size-3" />} title={m.label_handling()} />
                  <div className="grid grid-cols-1 gap-1.5">
                    {analysis.handling.map((item) => (
                      <MetricCard key={item.label} item={item} />
                    ))}
                  </div>
                </div>
              )}

              {/* Problem Corners */}
              {analysis.corners?.length > 0 && (
                <div>
                  <SectionHeader icon={<AlertTriangle className="size-3" />} title={m.label_problem_corners()} />
                  <div className="space-y-1.5">
                    {analysis.corners.map((corner) => (
                      <TrackCard
                        key={corner.name}
                        seg={findSegment(cornerFracs.length ? cornerFracs : segments, corner.name)}
                        color={corner.severity === "major" ? "critical" : corner.severity === "moderate" ? "warning" : "good"}
                        onJumpToFrac={onJumpToFrac}
                        onHighlightsChange={onHighlightsChange}
                        className="bg-app-surface-alt/40 border border-app-border-input/40 rounded-lg px-2.5 py-2"
                      >
                        <div className="flex items-center gap-1.5 mb-0.5">
                          <span className={`size-1.5 rounded-full ${SEVERITY_COLORS[corner.severity]}`} />
                          <span className="text-[11px] font-semibold text-app-text">{corner.name}</span>
                        </div>
                        <p className="text-[10px] text-app-text-secondary">{corner.issue}</p>
                        <p className="text-[10px] text-emerald-400/80 mt-0.5">{corner.fix}</p>
                      </TrackCard>
                    ))}
                  </div>
                </div>
              )}

              {/* Braking per corner */}
              {analysis.braking?.length > 0 && (
                <div>
                  <SectionHeader icon={<CircleDot className="size-3" />} title={m.label_braking_points()} />
                  <div className="space-y-1.5">
                    {analysis.braking.map((item) => (
                      <TrackCard
                        key={item.corner}
                        seg={findSegment(cornerFracs.length ? cornerFracs : segments, item.corner)}
                        color={item.assessment}
                        onJumpToFrac={onJumpToFrac}
                        onHighlightsChange={onHighlightsChange}
                        className={`rounded-lg border px-2.5 py-1.5 ${ASSESSMENT_BG[item.assessment]}`}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[11px] font-semibold text-app-text">{item.corner}</span>
                          <span className={`text-[10px] font-mono ${ASSESSMENT_COLORS[item.assessment]}`}>{item.brakePoint}</span>
                        </div>
                        <p className="text-[10px] text-app-text-secondary mt-0.5">{item.detail}</p>
                      </TrackCard>
                    ))}
                  </div>
                </div>
              )}

              {/* Throttle per corner */}
              {analysis.throttle?.length > 0 && (
                <div>
                  <SectionHeader icon={<Zap className="size-3" />} title={m.label_throttle_application()} />
                  <div className="space-y-1.5">
                    {analysis.throttle.map((item) => (
                      <TrackCard
                        key={item.corner}
                        seg={findSegment(cornerFracs.length ? cornerFracs : segments, item.corner)}
                        color={item.assessment}
                        onJumpToFrac={onJumpToFrac}
                        onHighlightsChange={onHighlightsChange}
                        className={`rounded-lg border px-2.5 py-1.5 ${ASSESSMENT_BG[item.assessment]}`}
                      >
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-[11px] font-semibold text-app-text">{item.corner}</span>
                          <span className={`text-[10px] font-mono ${ASSESSMENT_COLORS[item.assessment]}`}>{item.throttlePoint}</span>
                        </div>
                        <p className="text-[10px] text-app-text-secondary mt-0.5">{item.detail}</p>
                      </TrackCard>
                    ))}
                  </div>
                </div>
              )}

              {/* Coaching */}
              {analysis.coaching?.length > 0 && (
                <div>
                  <SectionHeader icon={<Lightbulb className="size-3" />} title={m.label_coaching()} />
                  <div className="space-y-1.5">
                    {analysis.coaching.map((item, i) => (
                      <TrackCard
                        key={item.tip}
                        seg={findSegment(cornerFracs.length ? cornerFracs : segments, item.tip, item.detail)}
                        color="warning"
                        onJumpToFrac={onJumpToFrac}
                        onHighlightsChange={onHighlightsChange}
                        className="flex gap-2"
                      >
                        <span className="text-amber-400/60 text-[10px] font-mono mt-0.5">{i + 1}.</span>
                        <div>
                          <span className="text-[11px] font-medium text-app-text">{item.tip}</span>
                          <p className="text-[10px] text-app-text-secondary mt-0.5">{item.detail}</p>
                        </div>
                      </TrackCard>
                    ))}
                  </div>
                </div>
              )}

              {/* Setup — collapsed into a button; opens a modal. Shared with AnalysisDisplay. */}
              {analysis.setup?.length > 0 && (
                <SetupSection
                  setup={analysis.setup}
                  hasTune={hasTune}
                  lookupSegs={cornerFracs.length ? cornerFracs : (segments ?? null)}
                  onJumpToFrac={onJumpToFrac}
                  onHighlightsChange={onHighlightsChange}
                />
              )}

              {/* Actions bar */}
              <div className="flex items-center gap-1.5 pt-1.5 border-t border-app-border-input/30">
                {usage && (
                  <span className="text-[9px] text-app-text-muted font-mono mr-auto">
                    {usage.inputTokens.toLocaleString()}↓ {usage.outputTokens.toLocaleString()}↑ ${usage.costUsd.toFixed(4)} {(usage.durationMs / 1000).toFixed(1)}s
                  </span>
                )}
                <button
                  type="button"
                  onClick={handleExport}
                  className="flex items-center gap-1 text-[9px] text-app-text-muted hover:text-app-text px-1.5 py-0.5 rounded border border-transparent hover:border-app-border-input transition-colors"
                  title={m.label_export_as_image()}
                >
                  <Download className="size-3" /> {m.aipanel_export()}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    clearChat();
                    fetchAnalysis(true);
                  }}
                  disabled={loading}
                  className="flex items-center gap-1 text-[9px] text-app-text-muted hover:text-app-text px-1.5 py-0.5 rounded border border-transparent hover:border-app-border-input transition-colors disabled:opacity-50"
                  title={m.aipanel_regenerate_title()}
                >
                  <RefreshCw className="size-3" /> {m.label_regenerate()}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    clearChat();
                    setAnalysis(null);
                    setUsage(null);
                    onHighlightsChange?.([]);
                  }}
                  className="flex items-center gap-1 text-[9px] text-app-text-muted hover:text-red-400 px-1.5 py-0.5 rounded border border-transparent hover:border-app-border-input transition-colors"
                  title={m.aipanel_clear_title()}
                >
                  <Trash2 className="size-3" /> {m.common_clear()}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Chat continues the conversation, below the analysis card. Only
            mounted once analysis exists (or chat has been used before) so
            the panel doesn't show an empty composer with nothing to discuss
            yet — matches the old gating behaviour. */}
        {!loading && analysis && (
          <div className="flex justify-end -mb-1">
            <button type="button" onClick={clearChat} className="text-[9px] text-app-text-muted hover:text-red-400 transition-colors">
              <Trash2 className="size-3" />
            </button>
          </div>
        )}
      </div>

      {!loading && analysis && (
        <div className="flex-1 min-h-0 flex flex-col border-t border-app-border">
          <ChatPanel
            key={chatRemountKey}
            api={`/api/laps/${lapId}/chat`}
            fetchHistory={() => fetchLapChatHistory(lapId)}
            historyQueryKey={["lap-chat-history", lapId, chatRemountKey]}
            remountKey={`${lapId}:${chatRemountKey}`}
            compactThreadId={`lap-${lapId}`}
          />
        </div>
      )}
    </div>
  );
});
