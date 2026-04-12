import type { RefObject } from "react";
import { Sparkles } from "lucide-react";
import { CompareAiPanel, type CompareAiPanelHandle } from "./CompareAiPanel";
import { Button } from "../ui/button";

interface CompareAiSidebarProps {
  lapA: { id: number; label: string; lapTime: number };
  lapB: { id: number; label: string; lapTime: number };
  panelRef: RefObject<CompareAiPanelHandle | null>;
  onClose: () => void;
}

export function CompareAiSidebar({ lapA, lapB, panelRef, onClose }: CompareAiSidebarProps) {
  return (
    <div className="w-[22rem] h-full shrink-0 border-l border-app-border bg-app-surface/50 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-app-border shrink-0">
        <div className="flex items-center gap-1.5">
          <Sparkles className="size-3 text-amber-400" />
          <span className="text-[10px] uppercase tracking-wider font-semibold text-app-text">AI Compare</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => panelRef.current?.clearChat()}
            className="text-[9px] text-app-text-muted hover:text-app-text"
            title="Clear chat"
          >
            Clear chat
          </button>
          <Button variant="app-ghost" size="app-sm" onClick={onClose}>✕</Button>
        </div>
      </div>
      <CompareAiPanel
        ref={panelRef}
        lapA={lapA}
        lapB={lapB}
        panelOpen={true}
      />
    </div>
  );
}
