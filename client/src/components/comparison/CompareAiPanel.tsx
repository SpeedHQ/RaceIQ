import { useState, useEffect, useCallback, useRef, useImperativeHandle, forwardRef } from "react";
import { createPortal } from "react-dom";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Sparkles, RefreshCw, Send, Trash2, Eye, X } from "lucide-react";
import { client } from "../../lib/rpc";
import { useSettings } from "../../hooks/queries";
import { useUiStore } from "../../stores/ui";
import { Button } from "../ui/button";
import { AnalysisDisplay, type AnalysisData } from "../ai/analysis-display";

type ParsedAnalysis = Partial<AnalysisData>;

interface LapHeader {
  id: number;
  label: string;
  lapTime: number;
}

interface CompareAiPanelProps {
  lapA: LapHeader;
  lapB: LapHeader;
  panelOpen?: boolean;
}

interface InputsSegment {
  name: string;
  type?: "corner" | "straight";
  deltaSeconds?: number;
  throttle: string;
  brake: string;
  steering: string;
  action?: string;
  severity: "minor" | "moderate" | "major";
}

interface InputsAnalysis {
  verdict: string;
  segments: InputsSegment[];
  coaching: { tip: string; detail: string; targetLap: "A" | "B" }[];
}

export interface CompareAiPanelHandle {
  clearChat: () => void;
  clearAll: () => void;
}

interface AnalysisSummary {
  verdict: string;
  cornerCount: number;
  brakingCount: number;
  throttleCount: number;
  coachingCount: number;
  setupCount: number;
  raw: ParsedAnalysis;
}

interface ChatMessage { role: string; content: string; }

function summarize(parsed: ParsedAnalysis): AnalysisSummary {
  return {
    verdict: parsed?.verdict ?? "",
    cornerCount: parsed?.corners?.length ?? 0,
    brakingCount: parsed?.braking?.length ?? 0,
    throttleCount: parsed?.throttle?.length ?? 0,
    coachingCount: parsed?.coaching?.length ?? 0,
    setupCount: parsed?.setup?.length ?? 0,
    raw: parsed,
  };
}

function useLapAnalysis(lapId: number, panelOpen: boolean) {
  const [summary, setSummary] = useState<AnalysisSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCached = useCallback(async () => {
    try {
      const res = await client.api.laps[":id"].analyse.$post({
        param: { id: String(lapId) },
        query: { cacheOnly: "true" },
      });
      if (!res.ok) return;
      const data = await res.json() as { analysis: string | object | null; cached: boolean };
      if (!data.cached || !data.analysis) return;
      const parsed = typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis;
      setSummary(summarize(parsed));
    } catch { /* ignore */ }
  }, [lapId]);

  const run = useCallback(async (regenerate = false) => {
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
      const data = await res.json() as { analysis: string | object | null };
      const parsed = typeof data.analysis === "string" ? JSON.parse(data.analysis as string) : data.analysis;
      setSummary(summarize(parsed));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to analyse");
    } finally {
      setLoading(false);
    }
  }, [lapId]);

  useEffect(() => {
    if (!panelOpen) return;
    loadCached();
  }, [lapId, panelOpen, loadCached]);

  // reset on lap change
  useEffect(() => {
    setSummary(null);
    setError(null);
  }, [lapId]);

  return { summary, loading, error, run };
}

function useInputsAnalysis(lapAId: number, lapBId: number, panelOpen: boolean) {
  const [analysis, setAnalysis] = useState<InputsAnalysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadCached = useCallback(async () => {
    try {
      const res = await fetch(`/api/laps/${lapAId}/compare/${lapBId}/inputs-analyse?cacheOnly=true`, { method: "POST" });
      if (!res.ok) return;
      const data = await res.json() as { analysis: string | object | null; cached: boolean };
      if (!data.cached || !data.analysis) return;
      const parsed = typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis;
      setAnalysis(parsed);
    } catch { /* ignore */ }
  }, [lapAId, lapBId]);

  const run = useCallback(async (regenerate = false) => {
    setLoading(true);
    setError(null);
    try {
      const url = `/api/laps/${lapAId}/compare/${lapBId}/inputs-analyse${regenerate ? "?regenerate=true" : ""}`;
      const res = await fetch(url, { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: "Unknown error" })) as { error?: string };
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const data = await res.json() as { analysis: string | object | null };
      const parsed = typeof data.analysis === "string" ? JSON.parse(data.analysis as string) : data.analysis;
      setAnalysis(parsed);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to analyse inputs");
    } finally {
      setLoading(false);
    }
  }, [lapAId, lapBId]);

  useEffect(() => {
    if (!panelOpen) return;
    loadCached();
  }, [panelOpen, loadCached]);

  useEffect(() => {
    setAnalysis(null);
    setError(null);
  }, [lapAId, lapBId]);

  return { analysis, loading, error, run };
}

function InputsSection({
  lapAId,
  lapBId,
  panelOpen,
  onView,
}: {
  lapAId: number;
  lapBId: number;
  panelOpen: boolean;
  onView: (analysis: InputsAnalysis) => void;
}) {
  const { analysis, loading, error, run } = useInputsAnalysis(lapAId, lapBId, panelOpen);

  return (
    <div className="rounded-lg border border-app-border-input/40 bg-app-surface-alt/30 px-2.5 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="w-2 h-2 rounded-full bg-gradient-to-r from-orange-500 to-blue-500" />
        <span className="text-[11px] font-semibold text-app-text truncate flex-1">Inputs Comparison (A vs B)</span>
        {analysis && (
          <button
            onClick={() => run(true)}
            disabled={loading}
            className="text-app-text-muted hover:text-app-text disabled:opacity-40"
            title="Regenerate"
          >
            <RefreshCw className="size-3" />
          </button>
        )}
      </div>

      {!analysis && !loading && !error && (
        <button
          onClick={() => run(false)}
          className="w-full flex items-center justify-center gap-1.5 text-[11px] px-2 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white transition-colors"
        >
          <Sparkles className="size-3" />
          Compare Inputs
        </button>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-[10px] text-app-text-muted py-1">
          <div className="size-3 border border-app-border-input border-t-amber-400 rounded-full animate-spin" />
          Comparing inputs…
        </div>
      )}

      {error && (
        <div className="text-[10px] text-red-400 mb-1">
          {error}
          <Button variant="app-outline" size="app-sm" onClick={() => run(false)} className="ml-2">Retry</Button>
        </div>
      )}

      {analysis && (
        <button
          onClick={() => onView(analysis)}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded bg-emerald-500/10 border border-emerald-500/30 hover:bg-emerald-500/15 transition-colors text-left"
        >
          <Sparkles className="size-3 text-emerald-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[10px] font-semibold text-emerald-300 uppercase tracking-wider">Inputs analysed</div>
            <div className="text-[9px] text-app-text-muted font-mono">
              {analysis.segments?.length ?? 0} segments · {analysis.coaching?.length ?? 0} tips
            </div>
          </div>
          <span className="flex items-center gap-1 text-[10px] text-app-text-secondary shrink-0">
            <Eye className="size-3" /> View
          </span>
        </button>
      )}
    </div>
  );
}

function LapSection({
  lap,
  dotClass,
  panelOpen,
  onAnalysisChange,
  onView,
}: {
  lap: LapHeader;
  dotClass: string;
  panelOpen: boolean;
  onAnalysisChange: (hasAnalysis: boolean) => void;
  onView: (label: string, summary: AnalysisSummary) => void;
}) {
  const { summary, loading, error, run } = useLapAnalysis(lap.id, panelOpen);

  useEffect(() => {
    onAnalysisChange(!!summary);
  }, [summary, onAnalysisChange]);

  return (
    <div className="rounded-lg border border-app-border-input/40 bg-app-surface-alt/30 px-2.5 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`w-2 h-2 rounded-full ${dotClass}`} />
        <span className="text-[11px] font-semibold text-app-text truncate flex-1">{lap.label}</span>
        {summary && (
          <button
            onClick={() => run(true)}
            disabled={loading}
            className="text-app-text-muted hover:text-app-text disabled:opacity-40"
            title="Regenerate"
          >
            <RefreshCw className="size-3" />
          </button>
        )}
      </div>

      {!summary && !loading && !error && (
        <button
          onClick={() => run(false)}
          className="w-full flex items-center justify-center gap-1.5 text-[11px] px-2 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white transition-colors"
        >
          <Sparkles className="size-3" />
          Analyse Lap
        </button>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-[10px] text-app-text-muted py-1">
          <div className="size-3 border border-app-border-input border-t-amber-400 rounded-full animate-spin" />
          Analysing…
        </div>
      )}

      {error && (
        <div className="text-[10px] text-red-400 mb-1">
          {error}
          <Button variant="app-outline" size="app-sm" onClick={() => run(false)} className="ml-2">Retry</Button>
        </div>
      )}

      {summary && (
        <button
          onClick={() => onView(lap.label, summary)}
          className="w-full flex items-center gap-2 px-2 py-1.5 rounded bg-emerald-500/10 border border-emerald-500/30 hover:bg-emerald-500/15 transition-colors text-left"
        >
          <Sparkles className="size-3 text-emerald-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[10px] font-semibold text-emerald-300 uppercase tracking-wider">Analysis complete</div>
            <div className="text-[9px] text-app-text-muted font-mono">
              {summary.cornerCount} corners · {summary.coachingCount} tips · {summary.setupCount} setup
            </div>
          </div>
          <span className="flex items-center gap-1 text-[10px] text-app-text-secondary shrink-0">
            <Eye className="size-3" /> View
          </span>
        </button>
      )}
    </div>
  );
}

const SEVERITY_DOT = {
  minor: "bg-app-text-dim",
  moderate: "bg-amber-500",
  major: "bg-red-500",
} as const;

function InputsModal({
  analysis,
  onClose,
}: {
  analysis: InputsAnalysis;
  onClose: () => void;
}) {
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-app-surface border border-app-border rounded-lg shadow-xl w-[720px] max-w-[95vw] max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="size-3.5 text-amber-400" />
            <span className="text-[11px] font-semibold text-app-text uppercase tracking-wider">Inputs Comparison</span>
          </div>
          <button onClick={onClose} className="text-app-text-muted hover:text-app-text">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {analysis.verdict && (
            <p className="text-[12px] text-app-text leading-relaxed">{analysis.verdict}</p>
          )}

          {analysis.segments?.length > 0 && (
            <div className="space-y-2">
              {analysis.segments.map((seg, i) => (
                <div
                  key={i}
                  className="rounded-lg border border-app-border-input/40 bg-app-surface-alt/40 px-2.5 py-2"
                >
                  <div className="flex items-center gap-2 mb-1.5">
                    <span className={`size-1.5 rounded-full ${SEVERITY_DOT[seg.severity] ?? SEVERITY_DOT.minor}`} />
                    <span className="text-[11px] font-semibold text-app-text">{seg.name}</span>
                    {seg.type && (
                      <span className="text-[9px] uppercase tracking-wider text-app-text-muted">{seg.type}</span>
                    )}
                    {typeof seg.deltaSeconds === "number" && (
                      <span className={`ml-auto text-[10px] font-mono ${
                        seg.deltaSeconds > 0.05 ? "text-red-400"
                        : seg.deltaSeconds < -0.05 ? "text-emerald-400"
                        : "text-app-text-muted"
                      }`}>
                        {seg.deltaSeconds >= 0 ? "+" : ""}{seg.deltaSeconds.toFixed(3)}s
                      </span>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-1 text-[11px] text-app-text-secondary">
                    <div><span className="text-emerald-400/70 font-medium">Throttle:</span> {seg.throttle}</div>
                    <div><span className="text-red-400/70 font-medium">Brake:</span> {seg.brake}</div>
                    <div><span className="text-cyan-400/70 font-medium">Steering:</span> {seg.steering}</div>
                  </div>
                  {seg.action && (
                    <div className="mt-1.5 flex items-start gap-1.5 rounded bg-amber-500/10 border border-amber-500/30 px-2 py-1.5">
                      <Sparkles className="size-3 text-amber-400 shrink-0 mt-0.5" />
                      <span className="text-[11px] text-amber-200 leading-snug">{seg.action}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {analysis.coaching?.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-app-text uppercase tracking-wider mb-1">Coaching</div>
              <div className="space-y-1.5">
                {analysis.coaching.map((c, i) => (
                  <div key={i} className="rounded border border-app-border-input/40 bg-app-surface-alt/30 px-2 py-1.5">
                    <div className="flex items-baseline gap-2">
                      <span className={`text-[9px] font-semibold uppercase tracking-wider px-1 py-0.5 rounded ${
                        c.targetLap === "A"
                          ? "bg-orange-500/15 text-orange-300 border border-orange-500/30"
                          : "bg-blue-500/15 text-blue-300 border border-blue-500/30"
                      }`}>Lap {c.targetLap}</span>
                      <span className="text-[11px] font-medium text-app-text">{c.tip}</span>
                    </div>
                    {c.detail && <p className="text-[10px] text-app-text-muted mt-0.5 ml-1">{c.detail}</p>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function AnalysisModal({
  label,
  summary,
  onClose,
}: {
  label: string;
  summary: AnalysisSummary;
  onClose: () => void;
}) {
  const a = summary.raw ?? {};
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-app-surface border border-app-border rounded-lg shadow-xl w-[640px] max-w-[95vw] max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="size-3.5 text-amber-400" />
            <span className="text-[11px] font-semibold text-app-text uppercase tracking-wider">AI Analysis</span>
            <span className="text-[11px] text-app-text-secondary truncate max-w-[300px]">{label}</span>
          </div>
          <button onClick={onClose} className="text-app-text-muted hover:text-app-text">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3">
          <AnalysisDisplay analysis={a as AnalysisData} />
        </div>
      </div>
    </div>,
    document.body,
  );
}

export const CompareAiPanel = forwardRef<CompareAiPanelHandle, CompareAiPanelProps>(function CompareAiPanel(
  { lapA, lapB, panelOpen = false },
  ref,
) {
  const { displaySettings } = useSettings();
  const openSettings = useUiStore((s) => s.openSettings);
  const aiConfigured = !!(displaySettings.geminiApiKeySet || displaySettings.openaiApiKeySet);

  const [hasA, setHasA] = useState(false);
  const [hasB, setHasB] = useState(false);
  const [viewing, setViewing] = useState<
    | { kind: "lap"; label: string; summary: AnalysisSummary }
    | { kind: "inputs"; analysis: InputsAnalysis }
    | null
  >(null);

  // Chat
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [streaming, setStreaming] = useState("");
  const [chatError, setChatError] = useState<string | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const loadChat = useCallback(async () => {
    try {
      const res = await fetch(`/api/laps/${lapA.id}/compare/${lapB.id}/chat`);
      if (res.ok) {
        const data = await res.json();
        setMessages(data.messages ?? []);
      }
    } catch { /* ignore */ }
  }, [lapA.id, lapB.id]);

  useEffect(() => {
    if (!panelOpen) return;
    loadChat();
  }, [panelOpen, loadChat]);

  // Reset chat on lap pair change
  useEffect(() => {
    setMessages([]);
    setChatInput("");
    setStreaming("");
    setChatError(null);
  }, [lapA.id, lapB.id]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streaming]);

  const sendChat = useCallback(async () => {
    const msg = chatInput.trim();
    if (!msg || chatLoading) return;
    setChatLoading(true);
    setChatError(null);
    setStreaming("");
    setMessages((prev) => [...prev, { role: "user", content: msg }]);
    setChatInput("");
    try {
      const res = await fetch(`/api/laps/${lapA.id}/compare/${lapB.id}/chat`, {
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
  }, [chatInput, chatLoading, lapA.id, lapB.id]);

  const clearChat = useCallback(async () => {
    try {
      await fetch(`/api/laps/${lapA.id}/compare/${lapB.id}/chat`, { method: "DELETE" });
    } catch { /* ignore */ }
    setMessages([]);
    setStreaming("");
    setChatError(null);
  }, [lapA.id, lapB.id]);

  useImperativeHandle(ref, () => ({
    clearChat,
    clearAll: clearChat,
  }), [clearChat]);

  if (!aiConfigured) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-center px-3">
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
    );
  }

  const bothReady = hasA && hasB;

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 overflow-y-auto min-h-0 px-3 py-3 space-y-3">
        <LapSection lap={lapA} dotClass="bg-orange-500" panelOpen={panelOpen} onAnalysisChange={setHasA} onView={(label, s) => setViewing({ kind: "lap", label, summary: s })} />
        <LapSection lap={lapB} dotClass="bg-blue-500" panelOpen={panelOpen} onAnalysisChange={setHasB} onView={(label, s) => setViewing({ kind: "lap", label, summary: s })} />
        <InputsSection lapAId={lapA.id} lapBId={lapB.id} panelOpen={panelOpen} onView={(a) => setViewing({ kind: "inputs", analysis: a })} />

        {!bothReady && (
          <div className="text-[10px] text-app-text-muted text-center py-2 border border-dashed border-app-border-input/40 rounded">
            Analyse both laps to start a comparison chat
          </div>
        )}

        {bothReady && (
          <>
            {messages.length > 0 && (
              <div className="flex justify-end">
                <button onClick={clearChat} className="text-[9px] text-app-text-muted hover:text-red-400">
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
                </div>
              </div>
            )}
          </>
        )}

        <div ref={chatEndRef} />
      </div>

      {bothReady && (
        <div className="shrink-0 border-t border-app-border p-2 flex gap-1.5">
          <textarea
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } }}
            placeholder="Ask about the comparison..."
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

      {viewing?.kind === "lap" && (
        <AnalysisModal
          label={viewing.label}
          summary={viewing.summary}
          onClose={() => setViewing(null)}
        />
      )}
      {viewing?.kind === "inputs" && (
        <InputsModal
          analysis={viewing.analysis}
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
});

