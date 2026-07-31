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
    <div className="flex h-[36rem] w-full shrink-0 flex-col overflow-hidden border-t border-app-border bg-app-surface shadow-2xl @5xl/workspace:absolute @5xl/workspace:inset-y-0 @5xl/workspace:right-0 @5xl/workspace:z-30 @5xl/workspace:h-full @5xl/workspace:w-[22rem] @5xl/workspace:border-t-0 @5xl/workspace:border-l @7xl/workspace:relative @7xl/workspace:inset-auto @7xl/workspace:z-auto @7xl/workspace:shadow-none">
      <div className="flex items-center justify-between px-3 py-2 border-b border-app-border shrink-0">
        <div className="flex items-center gap-1.5">
          <Sparkles className="size-3 text-ai-accent" />
          <span className="text-app-caption uppercase tracking-wider font-semibold text-app-text">{m.compare_ai_compare()}</span>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="app-danger" size="app-sm" onClick={() => panelRef.current?.clearChat()} title={m.compare_clear_chat()}>
            {m.compare_clear_chat()}
          </Button>
          <Button variant="app-ghost" size="app-sm" onClick={onClose}>
            ✕
          </Button>
        </div>
      </div>
      <CompareAiPanel lapA={lapA} lapB={lapB} panelOpen={true} segments={segments} onJumpToFrac={onJumpToFrac} />
    </div>
  );
}
