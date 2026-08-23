import { useEffect } from "react";
import { AnalysisResultCard, AnalysisSummaryRow } from "@/components/ai/analysis-summary";
import { m } from "@/paraglide/messages";
import { useAiRunAction, useInputsAnalysis, useLapAnalysis } from "./compare-ai-hooks";
import type { AnalysisSummary, InputsAnalysis, LapHeader } from "./compare-ai-types";

export function InputsSection({
  lapAId,
  lapBId,
  title,
  dotClass,
  panelOpen,
  aiConfigured,
  configureAi,
  onView,
}: {
  lapAId: number;
  lapBId: number;
  title: string;
  dotClass: string;
  panelOpen: boolean;
  aiConfigured: boolean;
  configureAi: () => void;
  onView: (analysis: InputsAnalysis) => void;
}) {
  const { analysis, loading, error, deleting, run, remove } = useInputsAnalysis(lapAId, lapBId, panelOpen);
  const runAi = useAiRunAction(aiConfigured, run, configureAi);

  return (
    <AnalysisResultCard
      title={title}
      dotClass={dotClass}
      hasResult={!!analysis}
      loading={loading}
      error={error}
      runLabel={m.compare_inputs_compare_button()}
      loadingLabel={m.compare_inputs_comparing()}
      retryLabel={m.compare_retry()}
      onRun={() => runAi(false)}
      onRetry={() => runAi(false)}
      onRegenerate={() => runAi(true)}
      onDelete={() => void remove()}
      deleteLabel="Delete inputs comparison"
      actionsDisabled={loading || deleting}
    >
      {analysis && (
        <AnalysisSummaryRow title={m.compare_inputs_analysed()} detail={`${analysis.segments?.length ?? 0} segments · ${analysis.coaching?.length ?? 0} tips`} onView={() => onView(analysis)} />
      )}
    </AnalysisResultCard>
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
  const { summary, loading, error, deleting, run, remove } = useLapAnalysis(lap.id, panelOpen);
  const runAi = useAiRunAction(aiConfigured, run, configureAi);

  useEffect(() => {
    onAnalysisChange(!!summary);
  }, [summary, onAnalysisChange]);

  return (
    <AnalysisResultCard
      title={lap.label}
      dotClass={dotClass}
      hasResult={!!summary}
      loading={loading}
      error={error}
      runLabel={m.compare_analyse_lap_button()}
      loadingLabel={m.compare_analysing()}
      retryLabel={m.compare_retry()}
      onRun={() => runAi(false)}
      onRetry={() => runAi(false)}
      onRegenerate={() => runAi(true)}
      onDelete={() => void remove()}
      deleteLabel={`Delete ${lap.label} analysis`}
      actionsDisabled={loading || deleting}
    >
      {summary && <AnalysisSummaryRow detail={`${summary.cornerCount} corners · ${summary.coachingCount} tips · ${summary.setupCount} setup`} onView={() => onView(lap.label, summary)} />}
    </AnalysisResultCard>
  );
}
