import type { RefObject } from "react";
import { m } from "../../paraglide/messages";
import { AiPanel, type AiPanelHandle, type AnalysisHighlight } from "../AiPanel";
import { PanelSectionHeader } from "../ui/panel-section-header";

interface AnalyseAiSidebarProps {
  lapId: number;
  carName: string;
  trackName: string;
  segments: { type: string; name: string; startFrac: number; endFrac: number }[] | null;
  aiPanelRef: RefObject<AiPanelHandle | null>;
  onJumpToFrac: (frac: number) => void;
  onHighlightsChange: (highlights: AnalysisHighlight[] | null) => void;
}

export function AnalyseAiSidebar({ lapId, carName, trackName, segments, aiPanelRef, onJumpToFrac, onHighlightsChange }: AnalyseAiSidebarProps) {
  return (
    <div className="w-[22rem] h-full shrink-0 border-l border-app-border bg-app-surface/50 flex flex-col overflow-hidden">
      <div className="shrink-0 px-3 py-2">
        <PanelSectionHeader title={m.analyse_ai_analysis()} />
      </div>
      <AiPanel ref={aiPanelRef} lapId={lapId} carName={carName} trackName={trackName} segments={segments} panelOpen={true} onJumpToFrac={onJumpToFrac} onHighlightsChange={onHighlightsChange} />
    </div>
  );
}
