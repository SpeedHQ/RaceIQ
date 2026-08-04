import { Sparkles } from "lucide-react";
import { m } from "../../paraglide/messages";
import { CompareAiPanel } from "./CompareAiPanel";

interface CompareAiSidebarProps {
  lapA: { id: number; label: string; lapTime: number };
  lapB: { id: number; label: string; lapTime: number };
  /** Named track segments (startFrac/endFrac) for AI-segment click resolution. */
  segments?: { name: string; startFrac: number; endFrac: number }[];
  /** Move the track cursor / chart to a normalised lap fraction. */
  onJumpToFrac?: (frac: number) => void;
}

export function CompareAiSidebar({ lapA, lapB, segments, onJumpToFrac }: CompareAiSidebarProps) {

  return (
    <div className="w-[22rem] h-full shrink-0 border-y border-l border-app-border bg-app-surface/50 flex flex-col overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-app-border shrink-0">
        <div className="flex items-center gap-1.5">
          <Sparkles className="size-3 text-ai-accent" />
          <span className="text-app-caption uppercase tracking-wider font-semibold text-app-text">{m.compare_ai_compare()}</span>
        </div>
      </div>
      <CompareAiPanel lapA={lapA} lapB={lapB} panelOpen={true} segments={segments} onJumpToFrac={onJumpToFrac} />
    </div>
  );
}
