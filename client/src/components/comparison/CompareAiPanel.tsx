import { Trash2 } from "lucide-react";
import { forwardRef, useCallback, useImperativeHandle, useState } from "react";
import { m } from "../../paraglide/messages";
import { useUiStore } from "../../stores/ui";
import { comparisonAiStateKey } from "../../lib/lap-ai-state-key";
import { client } from "../../lib/rpc";
import { rpcJson } from "../../lib/rpc-json";
import { ChatPanel } from "../ai-chat/ChatPanel";
import { Button } from "../ui/button";
import { PanelSectionHeader } from "../ui/panel-section-header";
import { useComparisonAiSettings } from "./compare-ai-hooks";
import { AnalysisModal, InputsModal } from "./compare-ai-modals";
import { InputsSection, LapSection } from "./compare-ai-sections";
import { type AnalysisSummary, type CompareAiPanelHandle, type CompareAiPanelProps, fetchCompareChatHistory, type InputsAnalysis } from "./compare-ai-types";

export type { CompareAiPanelHandle } from "./compare-ai-types";

export const CompareAiPanel = forwardRef<CompareAiPanelHandle, CompareAiPanelProps>(function CompareAiPanel({ gameId, lapA, lapB, panelOpen = false, segments: trackSegments, onJumpToFrac }, ref) {
  const qualityStateKey = comparisonAiStateKey(lapA, lapB);
  const { aiConfigured } = useComparisonAiSettings();
  const openSettings = useUiStore((s) => s.openSettings);
  const [hasA, setHasA] = useState(false);
  const [hasB, setHasB] = useState(false);
  const [viewing, setViewing] = useState<{ kind: "lap"; label: string; summary: AnalysisSummary } | { kind: "inputs"; analysis: InputsAnalysis } | null>(null);
  const [chatRemountKey, setChatRemountKey] = useState(0);
  const [analysisCollapsed, setAnalysisCollapsed] = useState(false);
  const headers = { "X-Game-Id": gameId };
  const clearChat = useCallback(async () => {
    try {
      await rpcJson<{ ok: true }>(
        await client.api.laps[":id1"].compare[":id2"].chat.$delete(
          { param: { id1: String(lapA.id), id2: String(lapB.id) } },
          { headers },
        ),
      );
    } catch {
      /* clearing chat is best-effort */
    } finally {
      setChatRemountKey((key) => key + 1);
    }
  }, [gameId, lapA.id, lapB.id]);
  useImperativeHandle(ref, () => ({ clearChat, clearAll: clearChat }), [clearChat]);
  const configureAi = useCallback(() => openSettings("ai"), [openSettings]);
  const bothReady = hasA && hasB;
  return (
    <div className="flex flex-col flex-1 min-h-0">
      <div className="flex max-h-[50%] min-h-0 shrink-0 flex-col gap-3 overflow-y-auto px-3 py-3">
        <PanelSectionHeader title={m.label_ai_analysis()} collapsed={analysisCollapsed} onToggle={() => setAnalysisCollapsed((collapsed) => !collapsed)} />
        {!analysisCollapsed && (
          <>
            <LapSection
              gameId={gameId}
              lap={lapA}
              dotClass="bg-(--comparison-lap-a)"
              panelOpen={panelOpen}
              aiConfigured={aiConfigured}
              configureAi={configureAi}
              onAnalysisChange={setHasA}
              onView={(label, s) => setViewing({ kind: "lap", label, summary: s })}
            />
            <LapSection
              gameId={gameId}
              lap={lapB}
              dotClass="bg-(--comparison-lap-b)"
              panelOpen={panelOpen}
              aiConfigured={aiConfigured}
              configureAi={configureAi}
              onAnalysisChange={setHasB}
              onView={(label, s) => setViewing({ kind: "lap", label, summary: s })}
            />
            <InputsSection gameId={gameId} lapA={lapA} lapB={lapB} panelOpen={panelOpen} aiConfigured={aiConfigured} configureAi={configureAi} onView={(analysis) => setViewing({ kind: "inputs", analysis })} />
            {!bothReady && <div className="rounded border border-dashed border-app-border-input/40 py-2 text-center text-app-caption text-app-text-muted">{m.compare_analyse_both_laps()}</div>}
          </>
        )}
      </div>
      {bothReady && (
        <div className="flex-1 min-h-0 flex flex-col border-t border-app-border">
          <div className="flex justify-end px-2 pt-1">
            <Button type="button" variant="destructive-outline" size="icon-xs" onClick={clearChat} aria-label={m.compare_clear_chat()} title={m.compare_clear_chat()}>
              <Trash2 aria-hidden="true" />
            </Button>
          </div>
          <ChatPanel
            key={`${qualityStateKey}:${chatRemountKey}`}
            api={`/api/laps/${lapA.id}/compare/${lapB.id}/chat`}
            onClearChat={clearChat}
            fetchHistory={(gen) => fetchCompareChatHistory(lapA.id, lapB.id, gameId, gen)}
            historyQueryKey={["compare-chat-history", gameId, lapA.id, lapB.id, qualityStateKey, chatRemountKey]}
            headers={headers}
          />
        </div>
      )}
      {viewing?.kind === "lap" && <AnalysisModal label={viewing.label} summary={viewing.summary} onClose={() => setViewing(null)} />}
      {viewing?.kind === "inputs" && <InputsModal analysis={viewing.analysis} onClose={() => setViewing(null)} trackSegments={trackSegments} onJumpToFrac={onJumpToFrac} />}
    </div>
  );
});
