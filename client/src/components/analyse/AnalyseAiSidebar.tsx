import { Sparkles } from "lucide-react";
import type { RefObject } from "react";
import { AiPanel, type AiPanelHandle } from "@/components/ai/AiPanel";
import type { AnalysisHighlight } from "@/components/ai/analysis-types";
import { m } from "../../paraglide/messages";
import { AiPanelMenu } from "./AiPanelMenu";

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
    <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-app-bg">
      <div className="flex items-center justify-between px-3 py-2 border-b border-app-border shrink-0">
        <div className="flex items-center gap-1.5">
          <Sparkles className="size-3 text-ai-accent" />
          <span className="text-app-caption uppercase tracking-wider font-semibold text-app-text">{m.analyse_ai_analysis()}</span>
        </div>
        <AiPanelMenu onClearChat={() => aiPanelRef.current?.clearChat()} onClearAnalysis={() => aiPanelRef.current?.clearAnalysis()} onClearAll={() => aiPanelRef.current?.clearAll()} />
      </div>
      <AiPanel ref={aiPanelRef} lapId={lapId} carName={carName} trackName={trackName} segments={segments} panelOpen={true} onJumpToFrac={onJumpToFrac} onHighlightsChange={onHighlightsChange} />
    </div>
  );
}
