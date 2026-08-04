import { Trash2 } from "lucide-react";
import { forwardRef, useCallback, useImperativeHandle, useState } from "react";
import { m } from "../../paraglide/messages";
import { useUiStore } from "../../stores/ui";
import { ChatPanel } from "../ai-chat/ChatPanel";
import { Button } from "../ui/button";
import { useComparisonAiSettings } from "./compare-ai-hooks";
import { AnalysisModal, InputsModal } from "./compare-ai-modals";
import { InputsSection, LapSection } from "./compare-ai-sections";
import { type AnalysisSummary, type CompareAiPanelHandle, type CompareAiPanelProps, fetchCompareChatHistory, type InputsAnalysis } from "./compare-ai-types";

export type { CompareAiPanelHandle } from "./compare-ai-types";

export const CompareAiPanel = forwardRef<CompareAiPanelHandle, CompareAiPanelProps>(function CompareAiPanel({ lapA, lapB, panelOpen = false, segments: trackSegments, onJumpToFrac }, ref) {
  const { aiConfigured } = useComparisonAiSettings();
  const openSettings = useUiStore((s) => s.openSettings);
  const [hasA, setHasA] = useState(false);
  const [hasB, setHasB] = useState(false);
  const [hasInputs, setHasInputs] = useState(false);
  const [viewing, setViewing] = useState<{ kind: "lap"; label: string; summary: AnalysisSummary } | { kind: "inputs"; analysis: InputsAnalysis } | null>(null);
  const [chatRemountKey, setChatRemountKey] = useState(0);
  const clearChat = useCallback(() => {
    fetch(`/api/laps/${lapA.id}/compare/${lapB.id}/chat`, { method: "DELETE" })
      .catch(() => {})
      .finally(() => setChatRemountKey((k) => k + 1));
  }, [lapA.id, lapB.id]);
  useImperativeHandle(ref, () => ({ clearChat, clearAll: clearChat }), [clearChat]);
  const configureAi = useCallback(() => openSettings("ai"), [openSettings]);
  const bothReady = hasA && hasB;
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex-1 overflow-y-auto min-h-0 px-3 py-3 space-y-3">
        <LapSection
          lap={lapA}
          dotClass="bg-(--comparison-lap-a)"
          panelOpen={panelOpen}
          aiConfigured={aiConfigured}
          configureAi={configureAi}
          onAnalysisChange={setHasA}
          onView={(label, s) => setViewing({ kind: "lap", label, summary: s })}
        />
        <LapSection
          lap={lapB}
          dotClass="bg-(--comparison-lap-b)"
          panelOpen={panelOpen}
          aiConfigured={aiConfigured}
          configureAi={configureAi}
          onAnalysisChange={setHasB}
          onView={(label, s) => setViewing({ kind: "lap", label, summary: s })}
        />
        <InputsSection lapAId={lapA.id} lapBId={lapB.id} panelOpen={panelOpen} aiConfigured={aiConfigured} configureAi={configureAi} onView={(analysis) => setViewing({ kind: "inputs", analysis })} />
        {!bothReady && <div className="text-app-caption text-app-text-muted text-center py-2 border border-dashed border-app-border-input/40 rounded">{m.compare_analyse_both_laps()}</div>}
      </div>
      {bothReady && (
        <div className="flex-1 min-h-0 flex flex-col border-t border-app-border">
          <div className="flex justify-end px-2 pt-1">
            <button type="button" onClick={clearChat} className="text-app-micro text-app-text-muted hover:text-status-danger">
              <Trash2 className="size-3" />
            </button>
          </div>
          <ChatPanel
            api={`/api/laps/${lapA.id}/compare/${lapB.id}/chat`}
            fetchHistory={(gen) => fetchCompareChatHistory(lapA.id, lapB.id, gen)}
            historyQueryKey={["compare-chat-history", lapA.id, lapB.id]}
            remountKey={`${lapA.id}:${lapB.id}`}
            compactThreadId={`compare-${Math.min(lapA.id, lapB.id)}-${Math.max(lapA.id, lapB.id)}`}
          />
        </div>
      )}
      {viewing?.kind === "lap" && <AnalysisModal label={viewing.label} summary={viewing.summary} onClose={() => setViewing(null)} />}
      {viewing?.kind === "inputs" && <InputsModal analysis={viewing.analysis} onClose={() => setViewing(null)} trackSegments={trackSegments} onJumpToFrac={onJumpToFrac} />}
    </div>
  );
}
