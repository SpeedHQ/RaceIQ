import { useEffect } from "react";
import { isEligibilityUsable, resolveEligibilityDecision } from "@shared/racing/quality/policies";
import { AnalysisResultCard, AnalysisSummaryRow } from "@/components/ai/analysis-summary";
import { m } from "@/paraglide/messages";
import { LapQualityBadge, localizedEligibilityDecisionText } from "@/components/LapQualityBadge";
import { comparisonAiStateKey, lapAiStateKey } from "@/lib/lap-ai-state-key";
import { useAiRunAction, useInputsAnalysis, useLapAnalysis } from "./compare-ai-hooks";
import type { AnalysisSummary, InputsAnalysis, LapHeader } from "./compare-ai-types";

export function InputsSection({
  lapA,
  lapB,
  panelOpen,
  aiConfigured,
  configureAi,
  onView,
}: {
  lapA: LapHeader;
  lapB: LapHeader;
  panelOpen: boolean;
  aiConfigured: boolean;
  configureAi: () => void;
  onView: (analysis: InputsAnalysis) => void;
}) {
  const { analysis, loading, error, deleting, run, remove } = useInputsAnalysis(lapA.id, lapB.id, comparisonAiStateKey(lapA, lapB), panelOpen);
  const runAi = useAiRunAction(aiConfigured, run, configureAi);
  const decisions = {
    lapA: resolveEligibilityDecision(lapA, "corner-trace"),
    lapB: resolveEligibilityDecision(lapB, "corner-trace"),
  };
  const usable = isEligibilityUsable(decisions.lapA) && isEligibilityUsable(decisions.lapB);
  const disabledReason = [
    { label: m.compare_lap_a(), decision: decisions.lapA },
    { label: m.compare_lap_b(), decision: decisions.lapB },
  ]
    .filter(({ decision }) => !isEligibilityUsable(decision))
    .map(({ label, decision }) => `${label}: ${localizedEligibilityDecisionText(decision)}`)
    .join(" ");

  return (
    <AnalysisResultCard
      title={m.compare_inputs_comparison_ab()}
      dotClass="bg-gradient-to-r from-comparison-lap-a to-comparison-lap-b"
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
      deleteLabel={m.compare_delete_inputs()}
      generationDisabled={loading || deleting || !usable}
      deletionDisabled={loading || deleting}
      disabledReason={!usable ? disabledReason : undefined}
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
  const { summary, loading, error, deleting, run, remove } = useLapAnalysis(lap.id, lapAiStateKey(lap), panelOpen);
  const runAi = useAiRunAction(aiConfigured, run, configureAi);
  const decision = resolveEligibilityDecision(lap, "corner-trace");
  const usable = isEligibilityUsable(decision);

  useEffect(() => {
    onAnalysisChange(!!summary);
  }, [summary, onAnalysisChange]);

  return (
    <AnalysisResultCard
      title={
        <>
          <span className="min-w-0 flex-1 truncate">{lap.label}</span>
          <LapQualityBadge lap={lap} policyId="corner-trace" />
        </>
      }
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
      deleteLabel={m.compare_delete_lap({ lap: lap.label })}
      generationDisabled={loading || deleting || !usable}
      deletionDisabled={loading || deleting}
      disabledReason={!usable ? localizedEligibilityDecisionText(decision) : undefined}
    >
      {summary && <AnalysisSummaryRow detail={`${summary.cornerCount} corners · ${summary.coachingCount} tips · ${summary.setupCount} setup`} onView={() => onView(lap.label, summary)} />}
    </AnalysisResultCard>
  );
}
