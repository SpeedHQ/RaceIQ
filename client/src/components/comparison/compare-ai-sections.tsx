import { RefreshCw, Sparkles } from "lucide-react";
import { useEffect } from "react";
import { AnalysisSummaryRow } from "@/components/ai/analysis-summary";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { useAiRunAction, useInputsAnalysis, useLapAnalysis } from "./compare-ai-hooks";
import type { AnalysisSummary, InputsAnalysis, LapHeader } from "./compare-ai-types";

export function InputsSection({
  lapAId,
  lapBId,
  panelOpen,
  aiConfigured,
  configureAi,
  onView,
}: {
  lapAId: number;
  lapBId: number;
  panelOpen: boolean;
  aiConfigured: boolean;
  configureAi: () => void;
  onView: (analysis: InputsAnalysis) => void;
}) {
  const { analysis, loading, error, run } = useInputsAnalysis(lapAId, lapBId, panelOpen);
  const runAi = useAiRunAction(aiConfigured, run, configureAi);

  return (
    <div className="rounded-lg border border-app-border-input/40 px-2.5 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="w-2 h-2 rounded-full bg-gradient-to-r from-(--comparison-lap-a) to-(--comparison-lap-b)" />
        <span className="text-app-compact font-semibold text-app-text truncate flex-1">{m.compare_inputs_comparison_ab()}</span>
        {analysis && (
          <Button
            type="button"
            onClick={() => runAi(true)}
            disabled={loading}
            className="text-app-text-muted hover:text-app-text disabled:opacity-40"
            title={aiConfigured ? m.label_regenerate() : m.ai_configure_feature()}
          >
            <RefreshCw className="size-3" />
          </Button>
        )}
      </div>

      {!analysis && !loading && !error && (
        <Button type="button" variant="app-primary" size="app-md" onClick={() => runAi(false)} className="w-full">
          <Sparkles className="size-3" />
          {aiConfigured ? m.compare_inputs_compare_button() : m.ai_configure_feature()}
        </Button>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-app-caption text-app-text-muted py-1">
          <div className="size-3 border border-app-border-input border-t-amber-400 rounded-full animate-spin" />
          {m.compare_inputs_comparing()}
        </div>
      )}

      {error && (
        <div className="text-app-caption text-status-danger mb-1">
          {error}
          <Button variant={aiConfigured ? "app-outline" : "app-primary"} size="app-sm" onClick={() => runAi(false)} className="ml-2">
            {aiConfigured ? m.compare_retry() : m.ai_configure_feature()}
          </Button>
        </div>
      )}

      {analysis && (
        <AnalysisSummaryRow title={m.compare_inputs_analysed()} detail={`${analysis.segments?.length ?? 0} segments · ${analysis.coaching?.length ?? 0} tips`} onView={() => onView(analysis)} />
      )}
    </div>
  );
}

export function LapSection({
  lap,
  dotClass,
  panelOpen,
  aiConfigured,
  configureAi,
  onAnalysisChange,
  onView,
}: {
  lap: LapHeader;
  dotClass: string;
  panelOpen: boolean;
  aiConfigured: boolean;
  configureAi: () => void;
  onAnalysisChange: (hasAnalysis: boolean) => void;
  onView: (label: string, summary: AnalysisSummary) => void;
}) {
  const { summary, loading, error, run } = useLapAnalysis(lap.id, panelOpen);
  const runAi = useAiRunAction(aiConfigured, run, configureAi);

  useEffect(() => {
    onAnalysisChange(!!summary);
  }, [summary, onAnalysisChange]);

  return (
    <div className="rounded-lg border border-app-border-input/40 px-2.5 py-2">
      <div className="flex items-center gap-2 mb-1.5">
        <span className={`w-2 h-2 rounded-full ${dotClass}`} />
        <span className="text-app-compact font-semibold text-app-text truncate flex-1">{lap.label}</span>
        {summary && (
          <Button
            type="button"
            onClick={() => runAi(true)}
            disabled={loading}
            className="text-app-text-muted hover:text-app-text disabled:opacity-40"
            title={aiConfigured ? m.label_regenerate() : m.ai_configure_feature()}
          >
            <RefreshCw className="size-3" />
          </Button>
        )}
      </div>

      {!summary && !loading && !error && (
        <Button type="button" variant="app-primary" size="app-md" onClick={() => runAi(false)} className="w-full">
          <Sparkles className="size-3" />
          {aiConfigured ? m.compare_analyse_lap_button() : m.ai_configure_feature()}
        </Button>
      )}

      {loading && (
        <div className="flex items-center gap-2 text-app-caption text-app-text-muted py-1">
          <div className="size-3 border border-app-border-input border-t-amber-400 rounded-full animate-spin" />
          {m.compare_analysing()}
        </div>
      )}

      {error && (
        <div className="text-app-caption text-status-danger mb-1">
          {error}
          <Button variant={aiConfigured ? "app-outline" : "app-primary"} size="app-sm" onClick={() => runAi(false)} className="ml-2">
            {aiConfigured ? m.compare_retry() : m.ai_configure_feature()}
          </Button>
        </div>
      )}

      {summary && <AnalysisSummaryRow detail={`${summary.cornerCount} corners · ${summary.coachingCount} tips · ${summary.setupCount} setup`} onView={() => onView(lap.label, summary)} />}
    </div>
  );
}
