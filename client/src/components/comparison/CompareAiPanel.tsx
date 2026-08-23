import { Trash2 } from "lucide-react";
import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import { m } from "../../paraglide/messages";
import { useUiStore } from "../../stores/ui";
import { ChatPanel } from "../ai-chat/ChatPanel";
import { Button } from "../ui/button";
import { PanelSectionHeader } from "../ui/panel-section-header";
import { useComparisonAiSettings } from "./compare-ai-hooks";
import { AnalysisModal, InputsModal } from "./compare-ai-modals";
import { InputsSection, LapSection } from "./compare-ai-sections";
import { type AnalysisSummary, type CompareAiPanelHandle, type CompareAiPanelProps, fetchCompareChatHistory, type InputsAnalysis } from "./compare-ai-types";

export type { CompareAiPanelHandle } from "./compare-ai-types";

const LAP_DOT_CLASSES = [
  "bg-(--comparison-lap-a)",
  "bg-(--comparison-lap-b)",
  "bg-(--visualization-series-3)",
  "bg-(--visualization-series-4)",
  "bg-(--visualization-series-5)",
  "bg-(--visualization-series-6)",
  "bg-(--visualization-series-7)",
  "bg-(--visualization-series-8)",
] as const;

export const CompareAiPanel = forwardRef<CompareAiPanelHandle, CompareAiPanelProps>(function CompareAiPanel({ laps, panelOpen = false, segments: trackSegments, onJumpToFrac }, ref) {
  const { aiConfigured } = useComparisonAiSettings();
  const openSettings = useUiStore((state) => state.openSettings);
  const referenceLap = laps[0];
  const comparedLaps = laps.slice(1);
  const [readyLapIds, setReadyLapIds] = useState<Set<number>>(() => new Set());
  const [activeComparedLapId, setActiveComparedLapId] = useState<number | null>(() => comparedLaps[0]?.id ?? null);
  const [viewing, setViewing] = useState<{ kind: "lap"; label: string; summary: AnalysisSummary } | { kind: "inputs"; analysis: InputsAnalysis } | null>(null);
  const [chatRemountKey, setChatRemountKey] = useState(0);
  const [analysisCollapsed, setAnalysisCollapsed] = useState(false);
  const activeComparedLap = comparedLaps.find((lap) => lap.id === activeComparedLapId) ?? comparedLaps[0] ?? null;

  useEffect(() => {
    if (!activeComparedLapId || !comparedLaps.some((lap) => lap.id === activeComparedLapId)) setActiveComparedLapId(comparedLaps[0]?.id ?? null);
  }, [activeComparedLapId, comparedLaps]);
  useEffect(() => {
    const selectedIds = new Set(laps.map((lap) => lap.id));
    setReadyLapIds((current) => {
      if ([...current].every((lapId) => selectedIds.has(lapId))) return current;
      return new Set([...current].filter((lapId) => selectedIds.has(lapId)));
    });
  }, [laps]);

  const updateLapReady = useCallback((lapId: number, hasAnalysis: boolean) => {
    setReadyLapIds((current) => {
      if (current.has(lapId) === hasAnalysis) return current;
      const next = new Set(current);
      if (hasAnalysis) next.add(lapId);
      else next.delete(lapId);
      return next;
    });
  }, []);
  const clearChat = useCallback(() => {
    if (!referenceLap || !activeComparedLap) return;
    fetch(`/api/laps/${referenceLap.id}/compare/${activeComparedLap.id}/chat`, { method: "DELETE" })
      .catch(() => {})
      .finally(() => setChatRemountKey((key) => key + 1));
  }, [activeComparedLap, referenceLap]);
  const clearAll = useCallback(() => {
    if (!referenceLap) return;
    void Promise.all(comparedLaps.map((lap) => fetch(`/api/laps/${referenceLap.id}/compare/${lap.id}/chat`, { method: "DELETE" }).catch(() => null))).finally(() =>
      setChatRemountKey((key) => key + 1),
    );
  }, [comparedLaps, referenceLap]);
  useImperativeHandle(ref, () => ({ clearChat, clearAll }), [clearAll, clearChat]);
  const configureAi = useCallback(() => openSettings("ai"), [openSettings]);
  const allReady = laps.length >= 2 && laps.every((lap) => readyLapIds.has(lap.id));

  if (!referenceLap || comparedLaps.length === 0) return null;
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex max-h-[55%] min-h-0 shrink-0 flex-col gap-3 overflow-y-auto px-3 py-3">
        <PanelSectionHeader title={m.label_ai_analysis()} collapsed={analysisCollapsed} onToggle={() => setAnalysisCollapsed((collapsed) => !collapsed)} />
        {!analysisCollapsed && (
          <>
            {laps.map((lap, index) => (
              <LapSection
                key={lap.id}
                lap={lap}
                dotClass={LAP_DOT_CLASSES[index % LAP_DOT_CLASSES.length]}
                panelOpen={panelOpen}
                aiConfigured={aiConfigured}
                configureAi={configureAi}
                onAnalysisChange={(hasAnalysis) => updateLapReady(lap.id, hasAnalysis)}
                onView={(label, summary) => setViewing({ kind: "lap", label, summary })}
              />
            ))}
            {comparedLaps.map((lap, index) => (
              <InputsSection
                key={lap.id}
                lapAId={referenceLap.id}
                lapBId={lap.id}
                title={`${m.compare_inputs_comparison()} A ↔ ${String.fromCharCode(66 + index)}`}
                dotClass={LAP_DOT_CLASSES[(index + 1) % LAP_DOT_CLASSES.length]}
                panelOpen={panelOpen}
                aiConfigured={aiConfigured}
                configureAi={configureAi}
                onView={(analysis) => setViewing({ kind: "inputs", analysis })}
              />
            ))}
            {!allReady && <div className="rounded border border-dashed border-app-border-input/40 py-2 text-center text-app-caption text-app-text-muted">{m.compare_analyse_selected_laps()}</div>}
          </>
        )}
      </div>
      {allReady && activeComparedLap && (
        <div className="flex-1 min-h-0 flex flex-col border-t border-app-border">
          <div className="flex items-center gap-1 overflow-x-auto px-2 pt-1">
            {comparedLaps.length > 1 &&
              comparedLaps.map((lap, index) => (
                <Button
                  key={lap.id}
                  type="button"
                  variant={lap.id === activeComparedLap.id ? "selected-toggle" : "app-ghost"}
                  size="app-sm"
                  onClick={() => setActiveComparedLapId(lap.id)}
                  title={lap.label}
                >
                  A ↔ {String.fromCharCode(66 + index)}
                </Button>
              ))}
            <Button type="button" variant="destructive-outline" size="icon-xs" className="ml-auto" onClick={clearChat} aria-label={m.compare_clear_chat()} title={m.compare_clear_chat()}>
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
          <ChatPanel
            key={`${activeComparedLap.id}:${chatRemountKey}`}
            api={`/api/laps/${referenceLap.id}/compare/${activeComparedLap.id}/chat`}
            fetchHistory={(generation) => fetchCompareChatHistory(referenceLap.id, activeComparedLap.id, generation)}
            historyQueryKey={["compare-chat-history", referenceLap.id, activeComparedLap.id, chatRemountKey]}
            remountKey={`${referenceLap.id}:${activeComparedLap.id}:${chatRemountKey}`}
            compactThreadId={`compare-${Math.min(referenceLap.id, activeComparedLap.id)}-${Math.max(referenceLap.id, activeComparedLap.id)}`}
          />
        </div>
      )}
      {viewing?.kind === "lap" && <AnalysisModal label={viewing.label} summary={viewing.summary} onClose={() => setViewing(null)} />}
      {viewing?.kind === "inputs" && <InputsModal analysis={viewing.analysis} onClose={() => setViewing(null)} trackSegments={trackSegments} onJumpToFrac={onJumpToFrac} />}
    </div>
  );
});
