import { Sparkles } from "lucide-react";
import type { RefObject } from "react";
import { m } from "../../paraglide/messages";
import { AiPanel, type AiPanelHandle, type AnalysisHighlight } from "../AiPanel";
import { Button } from "../ui/button";
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

export function AnalyseAiSidebar({ lapId, carName, trackName, segments, aiPanelRef, onClose, onJumpToFrac, onHighlightsChange }: AnalyseAiSidebarProps) {
  return (
    <div className="flex h-[36rem] w-full shrink-0 flex-col overflow-hidden border-t border-app-border bg-app-surface shadow-2xl @5xl/workspace:absolute @5xl/workspace:inset-y-0 @5xl/workspace:right-0 @5xl/workspace:z-30 @5xl/workspace:h-full @5xl/workspace:w-[22rem] @5xl/workspace:border-t-0 @5xl/workspace:border-l @7xl/workspace:relative @7xl/workspace:inset-auto @7xl/workspace:z-auto @7xl/workspace:shadow-none">
      <div className="flex items-center justify-between px-3 py-2 border-b border-app-border shrink-0">
        <div className="flex items-center gap-1.5">
          <Sparkles className="size-3 text-ai-accent" />
          <span className="text-app-caption uppercase tracking-wider font-semibold text-app-text">{m.analyse_ai_analysis()}</span>
        </div>
        <div className="flex items-center gap-2">
          <AiPanelMenu onClearChat={() => aiPanelRef.current?.clearChat()} onClearAnalysis={() => aiPanelRef.current?.clearAnalysis()} onClearAll={() => aiPanelRef.current?.clearAll()} />
          <Button variant="app-ghost" size="app-sm" onClick={onClose}>
            ✕
          </Button>
        </div>
      </div>
      <AiPanel ref={aiPanelRef} lapId={lapId} carName={carName} trackName={trackName} segments={segments} panelOpen={true} onJumpToFrac={onJumpToFrac} onHighlightsChange={onHighlightsChange} />
    </div>
  );
}
