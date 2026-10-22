import type { RefObject } from "react";
import { createPortal } from "react-dom";
import { AiPanel, type AiPanelHandle } from "@/components/ai/AiPanel";
import { AiPanelMenu } from "./AiPanelMenu";

interface AnalyseAiSidebarProps {
  lapId: number;
  headerTarget: HTMLDivElement | null;
  carName: string;
  trackName: string;
  segments: { type: string; name: string; startFrac: number; endFrac: number }[] | null;
  aiPanelRef: RefObject<AiPanelHandle | null>;
  onJumpToFrac: (frac: number) => void;
}

export function AnalyseAiSidebar({ lapId, headerTarget, carName, trackName, segments, aiPanelRef, onJumpToFrac }: AnalyseAiSidebarProps) {
  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden bg-app-bg">
      {headerTarget && createPortal(
        <AiPanelMenu onClearChat={() => aiPanelRef.current?.clearChat()} onClearAnalysis={() => aiPanelRef.current?.clearAnalysis()} onClearAll={() => aiPanelRef.current?.clearAll()} />,
        headerTarget,
      )}
      <AiPanel ref={aiPanelRef} lapId={lapId} carName={carName} trackName={trackName} segments={segments} panelOpen={true} onJumpToFrac={onJumpToFrac} />
    </div>
  );
}
