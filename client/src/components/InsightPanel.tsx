import type { InsightCategory, LapInsight } from "@shared/racing/analysis/laps/insights/types";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { m } from "@/paraglide/messages";
import { Button } from "./ui/button";

const SEVERITY_COLOR: Record<string, string> = {
  info: "var(--app-text-dim)",
  warning: "var(--status-warning)",
  critical: "var(--status-danger)",
};

function InsightRow({ insight, onJump }: { insight: LapInsight; onJump: (idx: number) => void }) {
  const [eventIdx, setEventIdx] = useState(0);
  const hasMultiple = insight.frameIndices.length > 1;

  return (
    <div className="group flex w-full items-stretch rounded border border-app-border bg-app-surface-alt transition-colors hover:bg-app-surface-hover">
      <Button type="button" variant="plain" size="content" onClick={() => onJump(insight.frameIndices[eventIdx])} className="min-w-0 flex-1 rounded-none px-2 py-1.5 text-left">
        <div className="flex items-start gap-1.5">
          <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: SEVERITY_COLOR[insight.severity] }} />
          <div className="min-w-0 flex-1">
            <div className="text-app-compact font-mono text-app-text">{insight.label}</div>
            <div className="text-app-caption text-app-text-muted">{insight.detail}</div>
          </div>
        </div>
      </Button>
      {hasMultiple && (
        <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
          <Button
            type="button"
            variant="app-ghost"
            size="icon-xs"
            aria-label={`Previous ${insight.label} event`}
            title="Previous event"
            onClick={() => {
              const prev = (eventIdx - 1 + insight.frameIndices.length) % insight.frameIndices.length;
              setEventIdx(prev);
              onJump(insight.frameIndices[prev]);
            }}
          >
            <ChevronLeft />
          </Button>
          <span className="min-w-7 text-center text-app-micro text-app-text-dim tabular-nums">
            {eventIdx + 1}/{insight.frameIndices.length}
          </span>
          <Button
            type="button"
            variant="app-ghost"
            size="icon-xs"
            aria-label={`Next ${insight.label} event`}
            title="Next event"
            onClick={() => {
              const next = (eventIdx + 1) % insight.frameIndices.length;
              setEventIdx(next);
              onJump(insight.frameIndices[next]);
            }}
          >
            <ChevronRight />
          </Button>
        </div>
      )}
    </div>
  );
}

export function InsightPanel({ insights, onJumpToFrame }: { insights: LapInsight[]; onJumpToFrame: (frameIdx: number) => void }) {
  const categories: { key: InsightCategory; icon: string; label: string }[] = [
    { key: "suspension", icon: "🔧", label: m.insight_category_suspension() },
    { key: "tires", icon: "🛞", label: m.label_tires() },
    { key: "driving", icon: "🏎️", label: m.insight_category_driving() },
    { key: "mechanical", icon: "⚙️", label: m.insight_category_mechanical() },
  ];
  return (
    <div className="space-y-3">
      {categories.map(({ key, icon, label }) => {
        const items = insights.filter((i) => i.category === key);
        return (
          <div key={key}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-xs">{icon}</span>
              <h4 className="text-app-caption text-app-text-muted uppercase tracking-wider font-semibold">{label}</h4>
              {items.length > 0 && <span className="text-app-micro bg-app-surface-alt text-app-text-secondary rounded-full px-1.5 tabular-nums">{items.length}</span>}
            </div>
            {items.length === 0 ? (
              <div className="text-app-caption text-app-text-dim pl-5">✓ No issues detected</div>
            ) : (
              <div className="space-y-0.5">
                {items.map((insight) => (
                  <InsightRow key={insight.id} insight={insight} onJump={onJumpToFrame} />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
