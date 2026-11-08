import type { RefObject } from "react";
import { m } from "@/paraglide/messages";
import { CompareAiPanel, type CompareAiPanelHandle } from "./CompareAiPanel";

interface CompareAiSidebarProps {
  lapA: { id: number; label: string; lapTime: number };
  lapB: { id: number; label: string; lapTime: number };
  panelRef: RefObject<CompareAiPanelHandle | null>;
  headerTarget: HTMLDivElement | null;
  width: number;
  /** Named track segments (startFrac/endFrac) for AI-segment click resolution. */
  segments?: { name: string; startFrac: number; endFrac: number }[];
  /** Move the track cursor / chart to a normalised lap fraction. */
  onJumpToFrac?: (frac: number) => void;
}

export function CompareAiSidebar({ lapA, lapB, panelRef, headerTarget, width, segments, onJumpToFrac }: CompareAiSidebarProps) {
  return (
    <section id="compare-ai-panel" aria-label={m.label_ai_analysis()} className="absolute inset-y-0 right-0 z-30 h-full min-h-0 max-w-[88vw] shrink-0 overflow-y-auto border-l border-app-border bg-app-bg @5xl/workspace:relative @5xl/workspace:inset-auto @5xl/workspace:z-auto" style={{ width }}>
      <CompareAiPanel ref={panelRef} lapA={lapA} lapB={lapB} panelOpen headerTarget={headerTarget} segments={segments} onJumpToFrac={onJumpToFrac} />
    </section>
  );
}
