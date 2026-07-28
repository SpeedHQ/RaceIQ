import type { UIMessage } from "ai";
import { RefreshCw, Sparkles, Trash2, X } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import { createPortal } from "react-dom";
import { useSettings } from "../../hooks/queries";
import { isAiConfigured } from "../../lib/is-ai-configured";
import { client } from "../../lib/rpc";
import { m } from "../../paraglide/messages";
import { useUiStore } from "../../stores/ui";
import { type AnalysisData, AnalysisDisplay } from "../ai/analysis-display";
import { AnalysisModalShell, AnalysisSummaryRow } from "../ai/analysis-summary";
import { ChatPanel } from "../ai-chat/ChatPanel";
import { Button } from "../ui/button";

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
  /** Named segments with `startFrac`/`endFrac` so AI-output `segments[i].name`
   *  can resolve to a track position when clicked. */
  segments?: { name: string; startFrac: number; endFrac: number }[];
  /** Move the track cursor / chart to a normalised lap fraction. */
  onJumpToFrac?: (frac: number) => void;
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

async function fetchCompareChatHistory(lapAId: number, lapBId: number, gen?: number): Promise<UIMessage[]> {
  const url = gen && gen > 1 ? `/api/laps/${lapAId}/compare/${lapBId}/chat?gen=${gen}` : `/api/laps/${lapAId}/compare/${lapBId}/chat`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = (await res.json()) as { messages?: UIMessage[] };
  return (data.messages ?? []).filter((m) => m.role === "user" || m.role === "assistant");
}

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
        const res = await client.api.laps[":id"].analyse.$post({
          param: { id: String(lapId) },
          query: regenerate ? { regenerate: "true" } : {},
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => ({ error: m.compare_unknown_error() }))) as { error?: string };
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { analysis: string | object | null };
        const parsed = typeof data.analysis === "string" ? JSON.parse(data.analysis as string) : data.analysis;
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
      const data = (await res.json()) as { analysis: string | object | null; cached: boolean };
      if (!data.cached || !data.analysis) return;
      const parsed = typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis;
      setAnalysis(parsed);
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
        const parsed = typeof data.analysis === "string" ? JSON.parse(data.analysis as string) : data.analysis;
        setAnalysis(parsed);
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : m.compare_analyse_inputs_failed());
      } finally {
        setLoading(false);
      }
    },
    [lapAId, lapBId],
  );

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

function InputsSection({ lapAId, lapBId, panelOpen, onView }: { lapAId: number; lapBId: number; panelOpen: boolean; onView: (analysis: InputsAnalysis) => void }) {
  const { analysis, loading, error, run } = useInputsAnalysis(lapAId, lapBId, panelOpen);

  return (
    <div className="rounded-lg border border-app-border-input/40 bg-app-surface-alt/30 px-2.5 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="w-2 h-2 rounded-full bg-gradient-to-r from-orange-500 to-blue-500" />
        <span className="text-[11px] font-semibold text-app-text truncate flex-1">{m.compare_inputs_comparison_ab()}</span>
        {analysis && (
          <button type="button" onClick={() => run(true)} disabled={loading} className="text-app-text-muted hover:text-app-text disabled:opacity-40" title={m.label_regenerate()}>
            <RefreshCw className="size-3" />
          </button>
        )}
      </div>

      {!analysis && !loading && !error && (
        <button
          type="button"
          onClick={() => run(false)}
          className="w-full flex items-center justify-center gap-1.5 text-[11px] px-2 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white transition-colors"
        >
          <Sparkles className="size-3" />
          {m.compare_inputs_compare_button()}
        </button>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-[10px] text-app-text-muted py-1">
          <div className="size-3 border border-app-border-input border-t-amber-400 rounded-full animate-spin" />
          {m.compare_inputs_comparing()}
        </div>
      )}

      {error && (
        <div className="text-[10px] text-red-400 mb-1">
          {error}
          <Button variant="app-outline" size="app-sm" onClick={() => run(false)} className="ml-2">
            {m.compare_retry()}
          </Button>
        </div>
      )}

      {analysis && (
        <AnalysisSummaryRow title={m.compare_inputs_analysed()} detail={`${analysis.segments?.length ?? 0} segments · ${analysis.coaching?.length ?? 0} tips`} onView={() => onView(analysis)} />
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
          <button type="button" onClick={() => run(true)} disabled={loading} className="text-app-text-muted hover:text-app-text disabled:opacity-40" title={m.label_regenerate()}>
            <RefreshCw className="size-3" />
          </button>
        )}
      </div>

      {!summary && !loading && !error && (
        <button
          type="button"
          onClick={() => run(false)}
          className="w-full flex items-center justify-center gap-1.5 text-[11px] px-2 py-1.5 rounded bg-cyan-600 hover:bg-cyan-500 text-white transition-colors"
        >
          <Sparkles className="size-3" />
          {m.compare_analyse_lap_button()}
        </button>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-[10px] text-app-text-muted py-1">
          <div className="size-3 border border-app-border-input border-t-amber-400 rounded-full animate-spin" />
          {m.compare_analysing()}
        </div>
      )}

      {error && (
        <div className="text-[10px] text-red-400 mb-1">
          {error}
          <Button variant="app-outline" size="app-sm" onClick={() => run(false)} className="ml-2">
            {m.compare_retry()}
          </Button>
        </div>
      )}

      {summary && <AnalysisSummaryRow detail={`${summary.cornerCount} corners · ${summary.coachingCount} tips · ${summary.setupCount} setup`} onView={() => onView(lap.label, summary)} />}
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
  trackSegments,
  onJumpToFrac,
}: {
  analysis: InputsAnalysis;
  onClose: () => void;
  trackSegments?: { name: string; startFrac: number; endFrac: number }[];
  onJumpToFrac?: (frac: number) => void;
}) {
  return createPortal(
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-to-close
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="bg-app-surface border border-app-border rounded-lg shadow-xl w-[720px] max-w-[95vw] max-h-[85vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-app-border shrink-0">
          <div className="flex items-center gap-2">
            <Sparkles className="size-3.5 text-amber-400" />
            <span className="text-[11px] font-semibold text-app-text uppercase tracking-wider">{m.compare_inputs_comparison()}</span>
          </div>
          <button type="button" onClick={onClose} className="text-app-text-muted hover:text-app-text">
            <X className="size-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
          {analysis.verdict && <p className="text-[12px] text-app-text leading-relaxed">{analysis.verdict}</p>}

          {analysis.segments?.length > 0 && (
            <div className="space-y-2">
              {analysis.segments.map((seg) => {
                // Resolve the AI-named segment to a track position so clicking
                // the card moves the chart/track cursor to that segment.
                const match = trackSegments?.find((s) => {
                  const sn = s.name.toLowerCase();
                  const gn = seg.name.toLowerCase();
                  return sn === gn || sn.includes(gn) || gn.includes(sn);
                });
                const clickable = !!(match && onJumpToFrac);
                return (
                  // biome-ignore lint/a11y/noStaticElementInteractions: optional jump-to-segment affordance, non-essential
                  <div
                    key={`${seg.name}-${seg.type ?? ""}-${seg.deltaSeconds ?? ""}`}
                    onClick={() => match && onJumpToFrac?.((match.startFrac + match.endFrac) / 2)}
                    className={`rounded-lg border border-app-border-input/40 bg-app-surface-alt/40 px-2.5 py-2 ${clickable ? "cursor-pointer hover:border-cyan-400/40 hover:bg-app-surface-alt/60 transition-colors" : ""}`}
                  >
                    <div className="flex items-center gap-2 mb-1.5">
                      <span className={`size-1.5 rounded-full ${SEVERITY_DOT[seg.severity] ?? SEVERITY_DOT.minor}`} />
                      <span className="text-[11px] font-semibold text-app-text">{seg.name}</span>
                      {seg.type && <span className="text-[9px] uppercase tracking-wider text-app-text-muted">{seg.type}</span>}
                      {typeof seg.deltaSeconds === "number" && (
                        <span className={`ml-auto text-[10px] font-mono ${seg.deltaSeconds > 0.05 ? "text-red-400" : seg.deltaSeconds < -0.05 ? "text-emerald-400" : "text-app-text-muted"}`}>
                          {seg.deltaSeconds >= 0 ? "+" : ""}
                          {seg.deltaSeconds.toFixed(3)}s
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-1 gap-1 text-[11px] text-app-text-secondary">
                      <div>
                        <span className="text-emerald-400/70 font-medium">{m.compare_throttle()}</span> {seg.throttle}
                      </div>
                      <div>
                        <span className="text-red-400/70 font-medium">{m.compare_brake()}</span> {seg.brake}
                      </div>
                      <div>
                        <span className="text-cyan-400/70 font-medium">{m.compare_steering()}</span> {seg.steering}
                      </div>
                    </div>
                    {seg.action && (
                      <div className="mt-1.5 flex items-start gap-1.5 rounded bg-amber-500/10 border border-amber-500/30 px-2 py-1.5">
                        <Sparkles className="size-3 text-amber-400 shrink-0 mt-0.5" />
                        <span className="text-[11px] text-amber-200 leading-snug">{seg.action}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {analysis.coaching?.length > 0 && (
            <div>
              <div className="text-[10px] font-semibold text-app-text uppercase tracking-wider mb-1">{m.label_coaching()}</div>
              <div className="space-y-1.5">
                {analysis.coaching.map((c) => (
                  <div key={`${c.targetLap}-${c.tip}`} className="rounded border border-app-border-input/40 bg-app-surface-alt/30 px-2 py-1.5">
                    <div className="flex items-baseline gap-2">
                      <span
                        className={`text-[9px] font-semibold uppercase tracking-wider px-1 py-0.5 rounded ${
                          c.targetLap === "A" ? "bg-orange-500/15 text-orange-300 border border-orange-500/30" : "bg-blue-500/15 text-blue-300 border border-blue-500/30"
                        }`}
                      >
                        {m.compare_lap_label()} {c.targetLap}
                      </span>
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

function AnalysisModal({ label, summary, onClose }: { label: string; summary: AnalysisSummary; onClose: () => void }) {
  const a = summary.raw ?? {};
  return (
    <AnalysisModalShell subtitle={label} onClose={onClose}>
      <AnalysisDisplay analysis={a as AnalysisData} />
    </AnalysisModalShell>
  );
}

export const CompareAiPanel = forwardRef<CompareAiPanelHandle, CompareAiPanelProps>(function CompareAiPanel({ lapA, lapB, panelOpen = false, segments: trackSegments, onJumpToFrac }, ref) {
  const { displaySettings } = useSettings();
  const openSettings = useUiStore((s) => s.openSettings);
  const aiConfigured = isAiConfigured(displaySettings);

  const [hasA, setHasA] = useState(false);
  const [hasB, setHasB] = useState(false);
  const [viewing, setViewing] = useState<{ kind: "lap"; label: string; summary: AnalysisSummary } | { kind: "inputs"; analysis: InputsAnalysis } | null>(null);

  const [chatRemountKey, setChatRemountKey] = useState(0);

  const clearChat = useCallback(() => {
    fetch(`/api/laps/${lapA.id}/compare/${lapB.id}/chat`, { method: "DELETE" })
      .catch(() => {})
      .finally(() => setChatRemountKey((k) => k + 1));
  }, [lapA.id, lapB.id]);

  useImperativeHandle(
    ref,
    () => ({
      clearChat,
      clearAll: clearChat,
    }),
    [clearChat],
  );

  if (!aiConfigured) {
    return (
      <div className="flex flex-col items-center justify-center py-12 gap-3 text-center px-3">
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
          {m.compare_setup_ai_button()}
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

        {!bothReady && <div className="text-[10px] text-app-text-muted text-center py-2 border border-dashed border-app-border-input/40 rounded">{m.compare_analyse_both_laps()}</div>}
      </div>

      {bothReady && (
        <div className="flex-1 min-h-0 flex flex-col border-t border-app-border">
          <div className="flex justify-end px-2 pt-1">
            <button type="button" onClick={clearChat} className="text-[9px] text-app-text-muted hover:text-red-400">
              <Trash2 className="size-3" />
            </button>
          </div>
          <ChatPanel
            key={chatRemountKey}
            api={`/api/laps/${lapA.id}/compare/${lapB.id}/chat`}
            fetchHistory={(gen) => fetchCompareChatHistory(lapA.id, lapB.id, gen)}
            historyQueryKey={["compare-chat-history", lapA.id, lapB.id, chatRemountKey]}
            remountKey={`${lapA.id}:${lapB.id}:${chatRemountKey}`}
            compactThreadId={`compare-${Math.min(lapA.id, lapB.id)}-${Math.max(lapA.id, lapB.id)}`}
          />
        </div>
      )}

      {viewing?.kind === "lap" && <AnalysisModal label={viewing.label} summary={viewing.summary} onClose={() => setViewing(null)} />}
      {viewing?.kind === "inputs" && <InputsModal analysis={viewing.analysis} onClose={() => setViewing(null)} trackSegments={trackSegments} onJumpToFrac={onJumpToFrac} />}
    </div>
  );
});
