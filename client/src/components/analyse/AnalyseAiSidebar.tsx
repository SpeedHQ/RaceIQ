import type { RefObject } from "react";
import { Sparkles } from "lucide-react";
import { AiPanel, type AnalysisHighlight, type AiPanelHandle } from "../AiPanel";
import { AiPanelMenu } from "./AiPanelMenu";

interface AnalyseAiSidebarProps {
  lapId: number;
  carName: string;
  trackName: string;
  segments: { type: string; name: string; startFrac: number; endFrac: number }[] | null;
  aiPanelRef: RefObject<AiPanelHandle | null>;
  telemetryLength: number;
  onClose: () => void;
  onJumpToFrac: (frac: number) => void;
  onHighlightsChange: (highlights: AnalysisHighlight[] | null) => void;
}

export function AnalyseAiSidebar({
  lapId,
  carName,
  trackName,
  segments,
  aiPanelRef,
  onClose,
  onJumpToFrac,
  onHighlightsChange,
}: AnalyseAiSidebarProps) {
  return (
    <div className="w-[22rem] h-full shrink-0 border-l border-app-border bg-app-surface/50 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-app-border shrink-0">
        <div className="flex items-center gap-1.5">
          <Sparkles className="size-3 text-amber-400" />
          <span className="text-[10px] uppercase tracking-wider font-semibold text-app-text">AI Analysis</span>
        </div>
        <div className="flex items-center gap-2">
          <AiPanelMenu
            onClearChat={() => aiPanelRef.current?.clearChat()}
            onClearAnalysis={() => aiPanelRef.current?.clearAnalysis()}
            onClearAll={() => aiPanelRef.current?.clearAll()}
          />
          <button onClick={onClose} className="text-app-text-muted hover:text-app-text text-xs">✕</button>
        </div>
      </div>
      <AiPanel
        ref={aiPanelRef}
        lapId={lapId}
        carName={carName}
        trackName={trackName}
        segments={segments}
        panelOpen={true}
        onJumpToFrac={onJumpToFrac}
        onHighlightsChange={onHighlightsChange}
      />
    </div>
  );
}
