import { useState, useEffect, useCallback } from "react";
import {
  Sparkles, X, RefreshCw, Gauge, Sliders, AlertTriangle,
  Lightbulb, Wrench, SlidersHorizontal,
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
  minor: "bg-slate-600",
  moderate: "bg-amber-500",
  major: "bg-red-500",
};

function MetricCard({ item }: { item: PaceItem | HandlingItem }) {
  return (
    <div className={`rounded-lg border px-3 py-2 ${ASSESSMENT_BG[item.assessment]}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-slate-400 uppercase tracking-wide">{item.label}</span>
        <span className={`text-sm font-mono font-semibold ${ASSESSMENT_COLORS[item.assessment]}`}>
          {item.value}
        </span>
      </div>
      <p className="text-[11px] text-slate-400 mt-1 leading-relaxed">{item.detail}</p>
    </div>
  );
}

function SectionHeader({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-2 mb-2.5">
      <span className="text-slate-400">{icon}</span>
      <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">{title}</h3>
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAnalysis = useCallback(
    async (regenerate = false) => {
      setLoading(true);
      setError(null);
      try {
        const url = `/api/laps/${lapId}/analyse${regenerate ? "?regenerate=true" : ""}`;
        const res = await fetch(url, { method: "POST" });
        if (!res.ok) {
          const data = await res.json().catch(() => ({ error: "Unknown error" }));
          throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        const parsed = typeof data.analysis === "string" ? JSON.parse(data.analysis) : data.analysis;
        setAnalysis(parsed);
      } catch (err: any) {
        setError(err.message || "Failed to fetch analysis");
      } finally {
        setLoading(false);
      }
    },
    [lapId]
  );

  useEffect(() => {
    if (open && lapId) {
      setAnalysis(null);
      fetchAnalysis(false);
    }
  }, [open, lapId, fetchAnalysis]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />

      <div className="relative z-10 w-full max-w-2xl max-h-[85vh] flex flex-col bg-slate-900 border border-slate-700 rounded-xl shadow-2xl mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-700 shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles className="size-4 text-amber-400 shrink-0" />
            <h2 className="text-sm font-semibold text-white truncate">
              AI Analysis — {carName} at {trackName}
            </h2>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors shrink-0 ml-2">
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div className="size-8 border-2 border-slate-600 border-t-amber-400 rounded-full animate-spin" />
              <p className="text-sm text-slate-400">Analysing lap telemetry...</p>
              <p className="text-xs text-slate-600">This may take up to 90 seconds</p>
            </div>
          )}

          {error && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <p className="text-sm text-red-400">{error}</p>
              <button
                onClick={() => fetchAnalysis(false)}
                className="text-xs text-slate-400 hover:text-white border border-slate-700 rounded px-3 py-1.5 transition-colors"
              >
                Retry
              </button>
            </div>
          )}

          {analysis && !loading && (
            <>
              {/* Verdict */}
              <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg px-4 py-3">
                <p className="text-sm text-slate-200 leading-relaxed">{analysis.verdict}</p>
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
                      <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded-lg px-3.5 py-2.5">
                        <div className="flex items-center gap-2 mb-1">
                          <span className={`size-2 rounded-full ${SEVERITY_COLORS[corner.severity]}`} />
                          <span className="text-xs font-semibold text-white">{corner.name}</span>
                        </div>
                        <p className="text-[11px] text-slate-400 mb-1">{corner.issue}</p>
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
                          <span className="text-xs font-medium text-slate-200">{item.tip}</span>
                          <p className="text-[11px] text-slate-400 mt-0.5">{item.detail}</p>
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
                      <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded-lg px-3.5 py-2.5">
                        <span className="text-xs font-semibold text-white">{item.change}</span>
                        <p className="text-[11px] text-slate-400 mt-1">
                          <span className="text-red-400/70">Symptom:</span> {item.symptom}
                        </p>
                        <p className="text-[11px] text-slate-400 mt-0.5">
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
                    {analysis.tuning.map((item, i) => (
                      <div key={i} className="bg-slate-800/40 border border-slate-700/40 rounded-lg px-3.5 py-2.5">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-xs font-semibold text-white">{item.component}</span>
                          <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${
                            item.direction === "increase" ? "bg-emerald-400/10 text-emerald-400" :
                            item.direction === "decrease" ? "bg-red-400/10 text-red-400" :
                            "bg-amber-400/10 text-amber-400"
                          }`}>
                            {item.direction === "increase" ? "+" : item.direction === "decrease" ? "-" : "~"} {item.target}
                          </span>
                        </div>
                        <p className="text-[11px] text-slate-400">{item.reason}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        {analysis && !loading && (
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-700 shrink-0">
            <button
              onClick={() => fetchAnalysis(true)}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-white border border-slate-700 rounded px-3 py-1.5 transition-colors disabled:opacity-50"
            >
              <RefreshCw className="size-3" />
              Regenerate
            </button>
            <button
              onClick={onClose}
              className="text-xs text-slate-400 hover:text-white border border-slate-700 rounded px-3 py-1.5 transition-colors"
            >
              Close
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
