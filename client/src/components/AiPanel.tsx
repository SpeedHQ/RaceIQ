import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from "react";
import { client } from "../lib/rpc";
import { useSettings } from "../hooks/queries";
import { useUiStore } from "../stores/ui";
import { Button } from "./ui/button";
import { toPng } from "html-to-image";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Sparkles, RefreshCw, Gauge, Sliders, AlertTriangle,
  Lightbulb, Wrench, Download,
  Send, Trash2, CircleDot, Zap,
} from "lucide-react";

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

interface PaceItem { label: string; value: string; assessment: "good" | "warning" | "critical"; detail: string; }
interface HandlingItem { label: string; value: string; assessment: "good" | "warning" | "critical"; detail: string; }
interface CornerItem { name: string; issue: string; fix: string; severity: "minor" | "moderate" | "major"; }
interface CornerBrakingItem { corner: string; assessment: "good" | "warning" | "critical"; brakePoint: string; detail: string; }
interface CornerThrottleItem { corner: string; assessment: "good" | "warning" | "critical"; throttlePoint: string; detail: string; }
interface CoachingItem { tip: string; detail: string; }
interface SetupItem { component: string; symptom: string; fix: string; current: string; target: string; direction: "increase" | "decrease" | "adjust"; }

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

function TuneBar({ current, target }: { current: number; target: number }) {
  const lo = Math.min(current, target);
  const hi = Math.max(current, target);
  const spread = hi - lo || 1;
  const min = Math.max(0, lo - spread * 1.5);
  const max = hi + spread * 1.5;
  const range = max - min || 1;
  const currentPct = ((current - min) / range) * 100;
  const targetPct = ((target - min) / range) * 100;
  return (
    <div className="relative h-3 mt-1 mb-0.5">
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-app-border-input/50 rounded-full" />
      <div className="absolute top-1/2 -translate-y-1/2 h-1 bg-amber-400/20 rounded-full" style={{ left: `${Math.min(currentPct, targetPct)}%`, width: `${Math.abs(targetPct - currentPct)}%` }} />
      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2" style={{ left: `${currentPct}%` }}>
        <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px] border-l-transparent border-r-transparent border-t-cyan-400" />
      </div>
      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2" style={{ left: `${targetPct}%` }}>
        <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-b-[6px] border-l-transparent border-r-transparent border-b-amber-400" />
      </div>
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
  seg, color, onJumpToFrac, onHighlightsChange, className, children,
}: {
  seg: Segment | null;
  color: "good" | "warning" | "critical";
  onJumpToFrac?: (frac: number) => void;
  onHighlightsChange?: (h: AnalysisHighlight[]) => void;
  className?: string;
  children: React.ReactNode;
}) {
  const clickable = !!(seg && onJumpToFrac);
  return (
    <div
      className={`${className ?? ""} ${clickable ? "cursor-pointer hover:brightness-110 transition" : ""}`}
      onClick={() => {
        if (!seg) return;
        onJumpToFrac?.((seg.startFrac + seg.endFrac) / 2);
        onHighlightsChange?.([{ startFrac: seg.startFrac, endFrac: seg.endFrac, color, label: seg.name }]);
      }}
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

// ── Chat types ───────────────────────────────────────────────

interface ChatMessage { role: string; content: string; }

export interface AiPanelHandle {
  clearChat: () => void;
  clearAnalysis: () => void;
  clearAll: () => void;
}

// ── Main component ───────────────────────────────────────────

export const AiPanel = forwardRef<AiPanelHandle, AiPanelProps>(function AiPanel({ lapId, carName, trackName, segments, onAnalysisLoaded, onJumpToFrac, onHighlightsChange, panelOpen = false }, ref) {
  const { displaySettings } = useSettings();
  const openSettings = useUiStore((s) => s.openSettings);
  const aiConfigured = !!(displaySettings.geminiApiKeySet || displaySettings.openaiApiKeySet);

  // Analysis state
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; model: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cornerFracs, setCornerFracs] = useState<Segment[]>([]);
  const [hasTune, setHasTune] = useState(false);
  const analysisRef = useRef<HTMLDivElement>(null);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    clearChat: () => {
      setMessages([]);
      setChatInput("");
      setStreaming("");
      setChatError(null);
      // Clear persisted chat only (keeps analysis)
      fetch(`/api/laps/${lapId}/chat`, { method: "DELETE" }).catch(() => {});
    },
    clearAnalysis: () => {
      setAnalysis(null);
      setUsage(null);
      setError(null);
      onHighlightsChange?.([]);
      // DELETE clears both chat + analysis on server
      fetch(`/api/laps/${lapId}/chat`, { method: "DELETE" }).catch(() => {});
    },
    clearAll: () => {
      setAnalysis(null);
      setUsage(null);
      setMessages([]);
      setChatInput("");
      setStreaming("");
      setChatError(null);
      setError(null);
      onHighlightsChange?.([]);
      fetch(`/api/laps/${lapId}/chat`, { method: "DELETE" }).catch(() => {});
    },
  }), [lapId, onHighlightsChange]);


  // Fetch analysis
  const fetchAnalysis = useCallback(async (regenerate = false) => {
    setLoading(true);
    setError(null);
    try {
      const res = await client.api.laps[":id"].analyse.$post({
        param: { id: String(lapId) },
        query: regenerate ? { regenerate: "true" } : {},
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Unknown error" })) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json() as { analysis: string | object | null; usage?: { inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; model: string }; cornerFracs?: { label: string; startFrac: number; endFrac: number }[]; hasTune?: boolean };
      const parsed = typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis;
      setAnalysis(parsed);
      if (data.usage) setUsage(data.usage);
      if (data.cornerFracs) {
        setCornerFracs(data.cornerFracs.map((c: { label: string; startFrac: number; endFrac: number }) => ({
          type: "corner", name: c.label, startFrac: c.startFrac, endFrac: c.endFrac,
        })));
      }
      setHasTune(!!data.hasTune);

      // Compute track highlights from analysis corners
      const segs: Segment[] = data.cornerFracs
        ? data.cornerFracs.map((c: { label: string; startFrac: number; endFrac: number }) => ({
            type: "corner", name: c.label, startFrac: c.startFrac, endFrac: c.endFrac,
          }))
        : (segments ?? []);
      const searchSegs = segs.length ? segs : null;
      const hl: AnalysisHighlight[] = [];
      for (const corner of parsed.corners ?? []) {
        const seg = findSegment(searchSegs, corner.name);
        if (seg) {
          hl.push({
            startFrac: seg.startFrac, endFrac: seg.endFrac,
            color: corner.severity === "major" ? "critical" : corner.severity === "moderate" ? "warning" : "good",
            label: corner.name,
          });
        }
      }
      for (const item of parsed.braking ?? []) {
        const seg = findSegment(searchSegs, item.corner);
        if (seg) {
          hl.push({ startFrac: seg.startFrac, endFrac: seg.endFrac, color: item.assessment, label: item.corner });
        }
      }
      for (const item of parsed.throttle ?? []) {
        const seg = findSegment(searchSegs, item.corner);
        if (seg) {
          hl.push({ startFrac: seg.startFrac, endFrac: seg.endFrac, color: item.assessment, label: item.corner });
        }
      }
      if (hl.length > 0) onHighlightsChange?.(hl);

      onAnalysisLoaded?.();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to fetch analysis");
    } finally {
      setLoading(false);
    }
  }, [lapId, onAnalysisLoaded, segments, onHighlightsChange]);

  // Load chat messages
  const loadChat = useCallback(async () => {
    try {
      const res = await fetch(`/api/laps/${lapId}/chat`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages ?? []);
      }
    } catch { /* ignore */ }
  }, [lapId]);

  // Load cached analysis (no AI call — returns null if not cached)
  const loadCachedAnalysis = useCallback(async () => {
    try {
      const res = await client.api.laps[":id"].analyse.$post({
        param: { id: String(lapId) },
        query: { cacheOnly: "true" },
      });
      if (!res.ok) return;
      const data = await res.json() as { analysis: string | object | null; cached: boolean; usage?: { inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; model: string }; cornerFracs?: { label: string; startFrac: number; endFrac: number }[]; hasTune?: boolean };
      if (!data.cached) return;
      const parsed = typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis;
      setAnalysis(parsed);
      if (data.usage) setUsage(data.usage);
      if (data.cornerFracs) {
        setCornerFracs(data.cornerFracs.map((c) => ({
          type: "corner" as const, name: c.label, startFrac: c.startFrac, endFrac: c.endFrac,
        })));
      }
      setHasTune(!!data.hasTune);
    } catch { /* ignore */ }
  }, [lapId]);

  // Load chat and cached analysis on open
  useEffect(() => {
    if (!panelOpen) return;
    loadChat();
    loadCachedAnalysis();
  }, [lapId, panelOpen, loadChat, loadCachedAnalysis]);

  // Reset on lap change
  useEffect(() => {
    setAnalysis(null);
    setMessages([]);
    setChatInput("");
    setStreaming("");
  }, [lapId]);

  // Auto-scroll chat
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

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

  // Send chat message
  const sendChat = useCallback(async () => {
    const msg = chatInput.trim();
    if (!msg || chatLoading) return;
    setChatLoading(true);
    setChatError(null);
    setStreaming("");
    setMessages((prev) => [...prev, { role: "user", content: msg }]);
    setChatInput("");
    try {
      const res = await fetch(`/api/laps/${lapId}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: msg }),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({ error: "Request failed" })) as { error?: string };
        throw new Error(errData.error || `HTTP ${res.status}`);
      }
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No stream");
      const decoder = new TextDecoder();
      let fullText = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        fullText += decoder.decode(value, { stream: true });
        setStreaming(fullText);
      }
      setStreaming("");
      setMessages((prev) => [...prev, { role: "assistant", content: fullText }]);
    } catch (err: unknown) {
      setChatError(err instanceof Error ? err.message : "Chat failed");
    } finally {
      setChatLoading(false);
    }
  }, [chatInput, chatLoading, lapId]);

  const clearChat = useCallback(async () => {
    try { await fetch(`/api/laps/${lapId}/chat`, { method: "DELETE" }); } catch { /* ignore */ }
    setMessages([]);
    setStreaming("");
    setChatError(null);
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
              <p className="text-[11px] text-app-text-secondary font-medium">AI not set up</p>
              <p className="text-[10px] text-app-text-muted mt-0.5">Add an API key to start analysing laps</p>
            </div>
            <button
              onClick={() => openSettings("ai")}
              className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded bg-amber-500 hover:bg-amber-400 text-black font-medium transition-colors"
            >
              Set up AI
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
              <p className="text-[11px] text-app-text-secondary font-medium">Analysing your lap</p>
              <p className="text-[10px] text-app-text-dim mt-1">Reviewing telemetry, corners, and setup data</p>
              <p className="text-[9px] text-app-text-dim mt-0.5">May take up to 90 seconds</p>
            </div>
            <div className="flex gap-1">
              <div className="size-1 rounded-full bg-amber-400 animate-pulse" />
              <div className="size-1 rounded-full bg-amber-400 animate-pulse [animation-delay:200ms]" />
              <div className="size-1 rounded-full bg-amber-400 animate-pulse [animation-delay:400ms]" />
            </div>
          </div>
        )}

        {/* Empty state — after clear */}
        {aiConfigured && !analysis && !loading && !error && messages.length === 0 && (
          <div className="flex flex-col items-center justify-center py-12 gap-3">
            <Sparkles className="size-5 text-amber-400" />
            <p className="text-[11px] text-app-text-muted">No analysis yet</p>
            <button
              onClick={() => fetchAnalysis(false)}
              className="flex items-center gap-1.5 text-[11px] px-3 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white transition-colors"
            >
              <Sparkles className="size-3" />
              Analyse Lap
            </button>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div className="flex justify-start">
            <div className="rounded-lg px-2.5 py-2 bg-red-400/10 border border-red-400/20">
              <p className="text-[11px] text-red-400">{error}</p>
              <Button variant="app-outline" size="app-sm" onClick={() => fetchAnalysis(false)} className="mt-1">
                Retry
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
                  <SectionHeader icon={<Gauge className="size-3" />} title="Pace" />
                  <div className="grid grid-cols-1 gap-1.5">{analysis.pace.map((item, i) => <MetricCard key={i} item={item} />)}</div>
                </div>
              )}

              {/* Handling */}
              {analysis.handling?.length > 0 && (
                <div>
                  <SectionHeader icon={<Sliders className="size-3" />} title="Handling" />
                  <div className="grid grid-cols-1 gap-1.5">{analysis.handling.map((item, i) => <MetricCard key={i} item={item} />)}</div>
                </div>
              )}

              {/* Problem Corners */}
              {analysis.corners?.length > 0 && (
                <div>
                  <SectionHeader icon={<AlertTriangle className="size-3" />} title="Problem Corners" />
                  <div className="space-y-1.5">
                    {analysis.corners.map((corner, i) => (
                      <TrackCard key={i} seg={findSegment(cornerFracs.length ? cornerFracs : segments, corner.name)} color={corner.severity === "major" ? "critical" : corner.severity === "moderate" ? "warning" : "good"} onJumpToFrac={onJumpToFrac} onHighlightsChange={onHighlightsChange} className="bg-app-surface-alt/40 border border-app-border-input/40 rounded-lg px-2.5 py-2">
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
                  <SectionHeader icon={<CircleDot className="size-3" />} title="Braking Points" />
                  <div className="space-y-1.5">
                    {analysis.braking.map((item, i) => (
                      <TrackCard key={i} seg={findSegment(cornerFracs.length ? cornerFracs : segments, item.corner)} color={item.assessment} onJumpToFrac={onJumpToFrac} onHighlightsChange={onHighlightsChange} className={`rounded-lg border px-2.5 py-1.5 ${ASSESSMENT_BG[item.assessment]}`}>
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
                  <SectionHeader icon={<Zap className="size-3" />} title="Throttle Application" />
                  <div className="space-y-1.5">
                    {analysis.throttle.map((item, i) => (
                      <TrackCard key={i} seg={findSegment(cornerFracs.length ? cornerFracs : segments, item.corner)} color={item.assessment} onJumpToFrac={onJumpToFrac} onHighlightsChange={onHighlightsChange} className={`rounded-lg border px-2.5 py-1.5 ${ASSESSMENT_BG[item.assessment]}`}>
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
                  <SectionHeader icon={<Lightbulb className="size-3" />} title="Coaching" />
                  <div className="space-y-1.5">
                    {analysis.coaching.map((item, i) => (
                      <TrackCard key={i} seg={findSegment(cornerFracs.length ? cornerFracs : segments, item.tip, item.detail)} color="warning" onJumpToFrac={onJumpToFrac} onHighlightsChange={onHighlightsChange} className="flex gap-2">
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

              {/* Setup */}
              {analysis.setup?.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 mb-2">
                    <span className="text-app-text-secondary"><Wrench className="size-3" /></span>
                    <h3 className="text-[10px] font-semibold text-app-text uppercase tracking-wider">Setup</h3>
                    {!hasTune && <span className="text-[8px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-400 border border-amber-400/20">Best Guess</span>}
                  </div>
                  {!hasTune && (
                    <p className="text-[9px] text-amber-400/70 mb-1.5 leading-snug">No tune data linked — values are estimated from telemetry. Link a tune for accurate setup suggestions.</p>
                  )}
                  <div className="grid grid-cols-1 gap-1.5">
                    {analysis.setup.map((item, i) => {
                      const extractNum = (s?: string) => { const m = s?.match(/-?\d+\.?\d*/); return m ? parseFloat(m[0]) : NaN; };
                      const currentNum = extractNum(item.current);
                      const targetNum = extractNum(item.target);
                      const hasBoth = !isNaN(currentNum) && !isNaN(targetNum) && currentNum !== targetNum;
                      return (
                        <TrackCard key={i} seg={findSegment(cornerFracs.length ? cornerFracs : segments, item.symptom, item.fix)} color="warning" onJumpToFrac={onJumpToFrac} onHighlightsChange={onHighlightsChange} className="bg-app-surface-alt/40 border border-app-border-input/40 rounded-lg px-2.5 py-2">
                          <span className="text-[11px] font-semibold text-app-text block mb-1">{item.component}</span>
                          <span className={`text-[9px] font-mono px-1 py-0.5 rounded ${
                            item.direction === "increase" ? "bg-emerald-400/10 text-emerald-400" :
                            item.direction === "decrease" ? "bg-red-400/10 text-red-400" :
                            "bg-amber-400/10 text-amber-400"
                          }`}>{item.current} → {item.target}</span>
                          {hasBoth && <TuneBar current={currentNum} target={targetNum} />}
                          <p className="text-[10px] text-app-text-secondary mt-1"><span className="text-red-400/70">Symptom:</span> {item.symptom}</p>
                          <p className="text-[10px] text-app-text-secondary mt-0.5"><span className="text-emerald-400/70">Fix:</span> {item.fix}</p>
                        </TrackCard>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Actions bar */}
              <div className="flex items-center gap-1.5 pt-1.5 border-t border-app-border-input/30">
                {usage && (
                  <span className="text-[9px] text-app-text-muted font-mono mr-auto">
                    {usage.inputTokens.toLocaleString()}↓ {usage.outputTokens.toLocaleString()}↑ ${usage.costUsd.toFixed(4)} {(usage.durationMs / 1000).toFixed(1)}s
                  </span>
                )}
                <button onClick={handleExport} className="flex items-center gap-1 text-[9px] text-app-text-muted hover:text-app-text px-1.5 py-0.5 rounded border border-transparent hover:border-app-border-input transition-colors" title="Export as image">
                  <Download className="size-3" /> Export
                </button>
                <button onClick={() => { clearChat(); fetchAnalysis(true); }} disabled={loading} className="flex items-center gap-1 text-[9px] text-app-text-muted hover:text-app-text px-1.5 py-0.5 rounded border border-transparent hover:border-app-border-input transition-colors disabled:opacity-50" title="Regenerate analysis and clear chat">
                  <RefreshCw className="size-3" /> Regenerate
                </button>
                <button onClick={() => { clearChat(); setAnalysis(null); setUsage(null); onHighlightsChange?.([]); }} className="flex items-center gap-1 text-[9px] text-app-text-muted hover:text-red-400 px-1.5 py-0.5 rounded border border-transparent hover:border-app-border-input transition-colors" title="Clear analysis and chat">
                  <Trash2 className="size-3" /> Clear
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Chat messages continue the conversation */}
        {!loading && (analysis || messages.length > 0) && (
          <>
            {messages.length > 0 && (
              <div className="flex justify-end">
                <button onClick={clearChat} className="text-[9px] text-app-text-muted hover:text-red-400 transition-colors">
                  <Trash2 className="size-3" />
                </button>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[90%] rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed ${
                  msg.role === "user"
                    ? "bg-cyan-600/20 border border-cyan-500/30 text-app-text"
                    : "bg-app-surface-alt/60 border border-app-border-input/40 text-app-text-secondary"
                }`}>
                  <div className="prose-chat"><Markdown remarkPlugins={[remarkGfm]}>{msg.content}</Markdown></div>
                </div>
              </div>
            ))}

            {streaming && (
              <div className="flex justify-start">
                <div className="max-w-[90%] rounded-lg px-2.5 py-1.5 text-[11px] leading-relaxed bg-app-surface-alt/60 border border-app-border-input/40 text-app-text-secondary">
                  <div className="prose-chat"><Markdown remarkPlugins={[remarkGfm]}>{streaming}</Markdown></div>
                </div>
              </div>
            )}

            {chatLoading && !streaming && (
              <div className="flex justify-start">
                <div className="rounded-lg px-2.5 py-1.5 bg-app-surface-alt/60 border border-app-border-input/40">
                  <div className="flex items-center gap-1.5">
                    <div className="size-1.5 rounded-full bg-app-text-dim animate-pulse" />
                    <div className="size-1.5 rounded-full bg-app-text-dim animate-pulse [animation-delay:150ms]" />
                    <div className="size-1.5 rounded-full bg-app-text-dim animate-pulse [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            )}

            {chatError && (
              <div className="flex justify-start">
                <div className="rounded-lg px-2.5 py-2 bg-red-400/10 border border-red-400/20">
                  <p className="text-[11px] text-red-400">{chatError}</p>
                  <Button variant="app-outline" size="app-sm" onClick={() => {
                    const lastUserMsg = [...messages].reverse().find(m => m.role === "user");
                    if (lastUserMsg) {
                      setChatInput(lastUserMsg.content);
                      setMessages(prev => prev.slice(0, -1));
                      setChatError(null);
                    }
                  }} className="mt-1">
                    Retry
                  </Button>
                </div>
              </div>
            )}
          </>
        )}

        <div ref={chatEndRef} />
      </div>

      {/* Chat input — pinned at bottom */}
      {!loading && (analysis || messages.length > 0) && (
        <div className="shrink-0 border-t border-app-border p-2 flex gap-1.5">
          <textarea
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
            placeholder="Chat about this lap..."
            disabled={chatLoading}
            rows={1}
            style={{ height: 'auto', maxHeight: '9.375rem' }}
            className="flex-1 bg-app-surface border border-app-border-input rounded px-3 py-2.5 text-[12px] text-app-text placeholder:text-app-text-muted focus:outline-none focus:border-cyan-500/50 disabled:opacity-50 resize-none overflow-y-auto"
            onInput={(e) => {
              const target = e.target as HTMLTextAreaElement;
              target.style.height = 'auto';
              target.style.height = target.scrollHeight + 'px';
            }}
          />
          <button
            onClick={sendChat}
            disabled={chatLoading || !chatInput.trim()}
            className="shrink-0 p-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white transition-colors disabled:opacity-40 self-end"
          >
            <Send className="size-3" />
          </button>
        </div>
      )}
    </div>
  );
});
