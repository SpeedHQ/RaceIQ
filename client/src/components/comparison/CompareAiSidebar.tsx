import { Sparkles, X } from "lucide-react";
import type { RefObject } from "react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { CompareAiPanel, type CompareAiPanelHandle } from "./CompareAiPanel";
import { comparisonAiStateKey, type LapHeader } from "./compare-ai-types";

interface CompareAiSidebarProps {
  lapA: LapHeader;
  lapB: LapHeader;
  panelRef: RefObject<CompareAiPanelHandle | null>;
  onClose: () => void;
  /** Named track segments (startFrac/endFrac) for AI-segment click resolution. */
  segments?: { name: string; startFrac: number; endFrac: number }[];
  /** Move the track cursor / chart to a normalised lap fraction. */
  onJumpToFrac?: (frac: number) => void;
}

export function CompareAiSidebar({ lapA, lapB, panelRef, onClose, segments, onJumpToFrac }: CompareAiSidebarProps) {
  const qualityStateKey = comparisonAiStateKey(lapA, lapB);
  return (
    <div className="flex h-[36rem] w-full shrink-0 flex-col overflow-hidden border-y border-app-border bg-app-surface/50 shadow-2xl @5xl/workspace:absolute @5xl/workspace:inset-y-0 @5xl/workspace:right-0 @5xl/workspace:z-30 @5xl/workspace:h-full @5xl/workspace:w-[22rem] @5xl/workspace:border-l @7xl/workspace:relative @7xl/workspace:inset-auto @7xl/workspace:z-auto @7xl/workspace:shadow-none">
      <div className="flex items-center justify-between px-3 py-2 border-b border-app-border shrink-0">
        <div className="flex items-center gap-1.5">
          <Sparkles className="size-3 text-ai-accent" />
          <span className="text-app-caption uppercase tracking-wider font-semibold text-app-text">{m.compare_ai_compare()}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="app-outline" size="app-sm" onClick={() => panelRef.current?.clearChat()} title={m.compare_clear_chat()}>
            {m.compare_clear_chat()}
          </Button>
          <Button variant="close-action" size="icon-xs" onClick={onClose} aria-label={m.common_close()}>
            <X aria-hidden="true" />
          </Button>
        </div>
      </div>
      <CompareAiPanel key={qualityStateKey} ref={panelRef} lapA={lapA} lapB={lapB} panelOpen={true} segments={segments} onJumpToFrac={onJumpToFrac} />
    </div>
  );
}
