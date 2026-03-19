import { useState, useEffect, useCallback } from "react";
import Markdown from "react-markdown";
import { Sparkles, X, RefreshCw } from "lucide-react";

interface AiAnalysisModalProps {
  lapId: number;
  open: boolean;
  onClose: () => void;
  carName: string;
  trackName: string;
}

export function AiAnalysisModal({
  lapId,
  open,
  onClose,
  carName,
  trackName,
}: AiAnalysisModalProps) {
  const [analysis, setAnalysis] = useState<string | null>(null);
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
        setAnalysis(data.analysis);
      } catch (err: any) {
        setError(err.message || "Failed to fetch analysis");
      } finally {
        setLoading(false);
      }
    },
    [lapId]
  );

  // Fetch on open
  useEffect(() => {
    if (open && lapId) {
      setAnalysis(null);
      fetchAnalysis(false);
    }
  }, [open, lapId, fetchAnalysis]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative z-10 w-full max-w-2xl max-h-[85vh] flex flex-col bg-slate-900 border border-slate-700 rounded-xl shadow-2xl mx-4">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-700">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-amber-400" />
            <h2 className="text-sm font-semibold text-white">
              AI Analysis — {carName} at {trackName}
            </h2>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white transition-colors"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
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
            <div className="prose prose-invert prose-sm max-w-none
              prose-headings:text-slate-200 prose-headings:font-semibold prose-headings:mt-5 prose-headings:mb-2
              prose-h2:text-base prose-h2:border-b prose-h2:border-slate-700/50 prose-h2:pb-1
              prose-p:text-slate-300 prose-p:leading-relaxed
              prose-li:text-slate-300
              prose-strong:text-white
              prose-ul:my-1 prose-li:my-0.5">
              <Markdown>{analysis}</Markdown>
            </div>
          )}
        </div>

        {/* Footer */}
        {analysis && !loading && (
          <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-700">
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
