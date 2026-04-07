import { useState, useEffect, useCallback, useRef } from "react";
import { client } from "../lib/rpc";
import { toPng } from "html-to-image";
import {
  Sparkles, X, RefreshCw, Gauge, Sliders, AlertTriangle,
  Lightbulb, Wrench, SlidersHorizontal, Download,
  MessageCircle, Send, Trash2,
} from "lucide-react";

interface AiAnalysisModalProps {
  lapId: number;
  open: boolean;
  onClose: () => void;
  carName: string;
  trackName: string;
}

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

interface TechniqueItem {
  tip: string;
  detail: string;
}

interface SetupItem {
  change: string;
  symptom: string;
  fix: string;
}

interface TuningItem {
  component: string;
  current: string;
  direction: "increase" | "decrease" | "adjust";
  target: string;
  reason: string;
}

interface AnalysisData {
  verdict: string;
  pace: PaceItem[];
  handling: HandlingItem[];
  corners: CornerItem[];
  technique: TechniqueItem[];
  setup: SetupItem[];
  tuning: TuningItem[];
}

const ASSESSMENT_COLORS = {
  good: "text-emerald-400",
  warning: "text-amber-400",
  critical: "text-red-400",
};

const ASSESSMENT_BG = {
  good: "bg-emerald-400/10 border-emerald-400/20",
  warning: "bg-amber-400/10 border-amber-400/20",
  critical: "bg-red-400/10 border-red-400/20",
};

const SEVERITY_COLORS = {
  minor: "bg-app-text-dim",
  moderate: "bg-amber-500",
  major: "bg-red-500",
};

function MetricCard({ item }: { item: PaceItem | HandlingItem }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${ASSESSMENT_BG[item.assessment]}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-app-text-secondary uppercase tracking-wide">{item.label}</span>
        <span className={`text-sm font-mono font-semibold ${ASSESSMENT_COLORS[item.assessment]}`}>
          {item.value}
        </span>
      </div>
      <p className="text-[11px] text-app-text-secondary mt-1 leading-relaxed">{item.detail}</p>
    </div>
  );
}

/** Visual bar showing current (cyan) and suggested (amber) values on a range. */
function TuneBar({ current, target }: { current: number; target: number }) {
  // Auto-determine range from the two values with padding
  const lo = Math.min(current, target);
  const hi = Math.max(current, target);
  const spread = hi - lo || 1;
  const min = Math.max(0, lo - spread * 1.5);
  const max = hi + spread * 1.5;
  const range = max - min || 1;
  const currentPct = ((current - min) / range) * 100;
  const targetPct = ((target - min) / range) * 100;

  return (
    <div className="relative h-3 mt-1.5 mb-0.5">
      {/* Track */}
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-app-border-input/50 rounded-full" />
      {/* Range highlight between current and target */}
      <div
        className="absolute top-1/2 -translate-y-1/2 h-1 bg-amber-400/20 rounded-full"
        style={{ left: `${Math.min(currentPct, targetPct)}%`, width: `${Math.abs(targetPct - currentPct)}%` }}
      />
      {/* Current marker (cyan) */}
      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2" style={{ left: `${currentPct}%` }}>
        <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px] border-l-transparent border-r-transparent border-t-cyan-400" />
      </div>
      {/* Target marker (amber) */}
      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2" style={{ left: `${targetPct}%` }}>
        <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-b-[6px] border-l-transparent border-r-transparent border-b-amber-400" />
      </div>
    </div>
  );
}

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      <span className="text-app-text-secondary">{icon}</span>
      <h3 className="text-xs font-semibold text-app-text uppercase tracking-wider">{title}</h3>
    </div>
  );
}

export function AiAnalysisModal({
  lapId,
  open,
  onClose,
  carName,
  trackName,
}: AiAnalysisModalProps) {
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [usage, setUsage] = useState<{ inputTokens: number; outputTokens: number; costUsd: number; durationMs: number; model: string } | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Chat state
  const [chatMessages, setChatMessages] = useState<Array<{ role: string; content: string }>>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);

  // Load persisted chat messages when modal opens
  const loadChatMessages = useCallback(async () => {
    try {
      const res = await fetch(`/api/laps/${lapId}/chat`);
      if (res.ok) {
        const data = await res.json();
        setChatMessages(data.messages ?? []);
      }
    } catch { /* ignore load errors */ }
  }, [lapId]);

  const fetchAnalysis = useCallback(
    async (regenerate = false) => {
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
        const data = await res.json();
        const parsed = typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis;
        setAnalysis(parsed);
        if (data.usage) setUsage(data.usage);
        // Load persisted chat after analysis loads
        loadChatMessages();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to fetch analysis");
      } finally {
        setLoading(false);
      }
    },
    [lapId, loadChatMessages]
  );

  const handleExportImage = useCallback(async () => {
    const el = contentRef.current;
    if (!el) return;

    // Temporarily expand to full scroll height
    const origMaxH = el.style.maxHeight;
    const origOverflow = el.style.overflow;
    const origFlex = el.style.flex;
    el.style.maxHeight = "none";
    el.style.overflow = "visible";
    el.style.flex = "none";

    try {
      const url = await toPng(el, {
        backgroundColor: "#0f172a",
        pixelRatio: 2,
        filter: (node) => !(node instanceof HTMLElement && node.dataset.excludeExport !== undefined),
      });
      const link = document.createElement("a");
      link.download = `ai-analysis-${carName}-${trackName}.png`.replace(/\s+/g, "-");
      link.href = url;
      link.click();
    } catch (err) {
      console.error("[AI] Image export failed:", err);
    } finally {
      el.style.maxHeight = origMaxH;
      el.style.overflow = origOverflow;
      el.style.flex = origFlex;
    }
  }, [carName, trackName]);

  const sendChat = useCallback(async () => {
    const msg = chatInput.trim();
    if (!msg || chatLoading) return;

    setChatMessages((prev) => [...prev, { role: "user", content: msg }]);
    setChatInput("");
    setChatLoading(true);
    setChatError(null);
    setStreamingContent("");

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
        const chunk = decoder.decode(value, { stream: true });
        fullText += chunk;
        setStreamingContent(fullText);
      }

      setStreamingContent("");
      setChatMessages((prev) => [...prev, { role: "assistant", content: fullText }]);
    } catch (err: unknown) {
      setChatError(err instanceof Error ? err.message : "Chat failed");
    } finally {
      setChatLoading(false);
    }
  }, [chatInput, chatLoading, lapId]);

  const clearChat = useCallback(async () => {
    try {
      await fetch(`/api/laps/${lapId}/chat`, { method: "DELETE" });
    } catch { /* ignore */ }
    setChatMessages([]);
    setStreamingContent("");
    setChatError(null);
  }, [lapId]);

  // Auto-scroll chat to bottom
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [chatMessages, streamingContent]);

  useEffect(() => {
    if (open && lapId) {
      setAnalysis(null);
      setChatMessages([]);
      setChatInput("");
      setStreamingContent("");
      setChatError(null);
      fetchAnalysis(false);
    }
  }, [open, lapId, fetchAnalysis]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} />

      <div className="relative z-10 w-full max-w-2xl max-h-[85vh] flex flex-col bg-app-surface border border-app-border-input rounded-xl shadow-2xl mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-app-border-input shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="size-4 text-amber-400 shrink-0" />
            <h2 className="text-sm font-semibold text-app-text truncate">
              AI Analysis — {carName} at {trackName}
            </h2>
          </div>
          <button onClick={onClose} className="text-app-text-secondary hover:text-app-text transition-colors shrink-0 ml-2">
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div ref={contentRef} className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div className="size-8 border-2 border-app-text-dim border-t-amber-400 rounded-full animate-spin" />
              <p className="text-sm text-app-text-secondary">Analysing lap telemetry...</p>
              <p className="text-xs text-app-text-dim">This may take up to 90 seconds</p>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <p className="text-sm text-red-400">{error}</p>
              <button
                onClick={() => fetchAnalysis(false)}
                className="text-xs text-app-text-secondary hover:text-app-text border border-app-border-input rounded px-3 py-1.5 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {analysis && !loading && (
            <>
              {/* Verdict */}
              <div className="bg-app-surface-alt/50 border border-app-border-input/50 rounded-lg px-4 py-3">
                <p className="text-sm text-app-text leading-relaxed">{analysis.verdict}</p>
              </div>

              {/* Pace */}
              {analysis.pace?.length > 0 && (
                <section>
                  <SectionHeader icon={<Gauge className="size-3.5" />} title="Pace" />
                  <div className="grid grid-cols-2 gap-2">
                    {analysis.pace.map((item, i) => <MetricCard key={i} item={item} />)}
                  </div>
                </section>
              )}

              {/* Handling */}
              {analysis.handling?.length > 0 && (
                <section>
                  <SectionHeader icon={<Sliders className="size-3.5" />} title="Handling" />
                  <div className="grid grid-cols-2 gap-2">
                    {analysis.handling.map((item, i) => <MetricCard key={i} item={item} />)}
                  </div>
                </section>
              )}

              {/* Problem Corners */}
              {analysis.corners?.length > 0 && (
                <section>
                  <SectionHeader icon={<AlertTriangle className="size-3.5" />} title="Problem Corners" />
                  <div className="space-y-2">
                    {analysis.corners.map((corner, i) => (
                      <div key={i} className="bg-app-surface-alt/40 border border-app-border-input/40 rounded-lg px-3.5 py-2.5">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`size-2 rounded-full ${SEVERITY_COLORS[corner.severity]}`} />
                          <span className="text-xs font-semibold text-app-text">{corner.name}</span>
                        </div>
                        <p className="text-[11px] text-app-text-secondary mb-1">{corner.issue}</p>
                        <p className="text-[11px] text-emerald-400/80">{corner.fix}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Technique */}
              {analysis.technique?.length > 0 && (
                <section>
                  <SectionHeader icon={<Lightbulb className="size-3.5" />} title="Technique" />
                  <div className="space-y-2">
                    {analysis.technique.map((item, i) => (
                      <div key={i} className="flex gap-2.5">
                        <span className="text-amber-400/60 text-xs font-mono mt-0.5">{i + 1}.</span>
                        <div>
                          <span className="text-xs font-medium text-app-text">{item.tip}</span>
                          <p className="text-[11px] text-app-text-secondary mt-0.5">{item.detail}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Setup */}
              {analysis.setup?.length > 0 && (
                <section>
                  <SectionHeader icon={<Wrench className="size-3.5" />} title="Setup Changes" />
                  <div className="space-y-2">
                    {analysis.setup.map((item, i) => (
                      <div key={i} className="bg-app-surface-alt/40 border border-app-border-input/40 rounded-lg px-3.5 py-2.5">
                        <span className="text-xs font-semibold text-app-text">{item.change}</span>
                        <p className="text-[11px] text-app-text-secondary mt-1">
                          <span className="text-red-400/70">Symptom:</span> {item.symptom}
                        </p>
                        <p className="text-[11px] text-app-text-secondary mt-0.5">
                          <span className="text-emerald-400/70">Fix:</span> {item.fix}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Tuning */}
              {analysis.tuning?.length > 0 && (
                <section>
                  <SectionHeader icon={<SlidersHorizontal className="size-3.5" />} title="Tuning Values" />
                  <div className="grid grid-cols-1 gap-1.5">
                    {analysis.tuning.map((item, i) => {
                      const currentNum = parseFloat(item.current?.replace(/[^0-9.-]/g, "") ?? "");
                      const targetNum = parseFloat(item.target?.replace(/[^0-9.-]/g, "") ?? "");
                      const hasBoth = !isNaN(currentNum) && !isNaN(targetNum) && currentNum !== targetNum;

                      return (
                        <div key={i} className="bg-app-surface-alt/40 border border-app-border-input/40 rounded-lg px-3.5 py-2.5">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-xs font-semibold text-app-text">{item.component}</span>
                            <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                              item.direction === "increase" ? "bg-emerald-400/10 text-emerald-400" :
                              item.direction === "decrease" ? "bg-red-400/10 text-red-400" :
                              "bg-amber-400/10 text-amber-400"
                            }`}>
                              {item.current} → {item.target}
                            </span>
                          </div>
                          {hasBoth && <TuneBar current={currentNum} target={targetNum} />}
                          <p className="text-[11px] text-app-text-secondary mt-1">{item.reason}</p>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Chat */}
              <div data-exclude-export>
                <div className="flex items-center gap-2 pt-2 border-t border-app-border-input/50">
                  <MessageCircle className="size-3.5 text-app-text-secondary" />
                  <h3 className="text-xs font-semibold text-app-text uppercase tracking-wider flex-1">Chat</h3>
                  {chatMessages.length > 0 && (
                    <button
                      onClick={clearChat}
                      className="flex items-center gap-1 text-[10px] text-app-text-muted hover:text-red-400 transition-colors"
                    >
                      <Trash2 className="size-3" />
                      Clear
                    </button>
                  )}
                </div>

                {/* Messages */}
                {chatMessages.length > 0 && (
                  <div className="space-y-2.5 mt-3">
                    {chatMessages.map((msg, i) => (
                      <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                        <div className={`max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed ${
                          msg.role === "user"
                            ? "bg-cyan-600/20 border border-cyan-500/30 text-app-text"
                            : "bg-app-surface-alt/60 border border-app-border-input/40 text-app-text-secondary"
                        }`}>
                          <div className="whitespace-pre-wrap">{msg.content}</div>
                        </div>
                      </div>
                    ))}

                    {/* Streaming response */}
                    {streamingContent && (
                      <div className="flex justify-start">
                        <div className="max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed bg-app-surface-alt/60 border border-app-border-input/40 text-app-text-secondary">
                          <div className="whitespace-pre-wrap">{streamingContent}</div>
                        </div>
                      </div>
                    )}

                    {/* Loading indicator */}
                    {chatLoading && !streamingContent && (
                      <div className="flex justify-start">
                        <div className="rounded-lg px-3 py-2 bg-app-surface-alt/60 border border-app-border-input/40">
                          <div className="flex items-center gap-1.5">
                            <div className="size-1.5 rounded-full bg-app-text-dim animate-pulse" />
                            <div className="size-1.5 rounded-full bg-app-text-dim animate-pulse [animation-delay:150ms]" />
                            <div className="size-1.5 rounded-full bg-app-text-dim animate-pulse [animation-delay:300ms]" />
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {chatError && (
                  <p className="text-[11px] text-red-400 mt-2">{chatError}</p>
                )}

                {/* Input */}
                <div className="flex items-center gap-2 mt-3">
                  <input
                    type="text"
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
                    placeholder="Ask a follow-up question..."
                    disabled={chatLoading}
                    className="flex-1 bg-app-surface border border-app-border-input rounded-lg px-3 py-2 text-xs text-app-text placeholder:text-app-text-muted focus:outline-none focus:border-cyan-500/50 disabled:opacity-50"
                  />
                  <button
                    onClick={sendChat}
                    disabled={chatLoading || !chatInput.trim()}
                    className="shrink-0 p-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white transition-colors disabled:opacity-40 disabled:hover:bg-cyan-600"
                  >
                    <Send className="size-3.5" />
                  </button>
                </div>
                <div ref={chatEndRef} />
              </div>
            </>
          )}
        </div>

        {/* Footer */}
        {analysis && !loading && (
          <div className="flex items-center gap-2 px-5 py-3 border-t border-app-border-input shrink-0">
            {usage && (
              <div className="flex items-center gap-3 text-[10px] text-app-text-muted font-mono mr-auto">
                <span>{usage.inputTokens.toLocaleString()} in</span>
                <span>{usage.outputTokens.toLocaleString()} out</span>
                <span>${usage.costUsd.toFixed(4)}</span>
                <span>{(usage.durationMs / 1000).toFixed(1)}s</span>
              </div>
            )}
            <button
              onClick={handleExportImage}
              className="flex items-center gap-1.5 text-xs text-app-text-secondary hover:text-app-text border border-app-border-input rounded px-3 py-1.5 transition-colors"
            >
              <Download className="size-3" />
              Save Image
            </button>
            <button
              onClick={() => fetchAnalysis(true)}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs text-app-text-secondary hover:text-app-text border border-app-border-input rounded px-3 py-1.5 transition-colors disabled:opacity-50"
            >
              <RefreshCw className="size-3" />
              Regenerate
            </button>
            <button
              onClick={onClose}
              className="text-xs text-app-text-secondary hover:text-app-text border border-app-border-input rounded px-3 py-1.5 transition-colors"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
