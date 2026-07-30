import { useState } from "react";
import { m } from "@/paraglide/messages";
import type { InsightCategory, LapInsight } from "../lib/lap-insights";

const SEVERITY_COLOR: Record<string, string> = {
  info: "var(--app-text-dim)",
  warning: "var(--status-warning)",
  critical: "var(--status-danger)",
};

function InsightRow({ insight, onJump }: { insight: LapInsight; onJump: (idx: number) => void }) {
  const [eventIdx, setEventIdx] = useState(0);
  const hasMultiple = insight.frameIndices.length > 1;

  return (
    <div className="w-full rounded hover:bg-app-surface-hover/60 transition-colors group">
      <button
        type="button"
        onClick={() => onJump(insight.frameIndices[eventIdx])}
        className={`block w-full text-left px-2 ${hasMultiple ? "pt-1.5" : "py-1.5"}`}
      >
        <div className="flex items-start gap-1.5">
          <span className="mt-1 w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: SEVERITY_COLOR[insight.severity] }} />
          <div className="min-w-0 flex-1">
            <div className="text-app-compact font-mono text-app-text group-hover:text-app-text">{insight.label}</div>
            <div className="text-app-caption text-app-text-muted">{insight.detail}</div>
          </div>
        </div>
      </button>
      {hasMultiple && (
        <div className="flex items-center gap-1 mt-1 ml-5 pb-1.5">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const prev = (eventIdx - 1 + insight.frameIndices.length) % insight.frameIndices.length;
              setEventIdx(prev);
              onJump(insight.frameIndices[prev]);
            }}
            className="text-app-micro text-app-text-muted hover:text-app-text px-1"
          >
            ‹
          </button>
          <span className="text-app-micro text-app-text-dim tabular-nums">
            {eventIdx + 1}/{insight.frameIndices.length}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const next = (eventIdx + 1) % insight.frameIndices.length;
              setEventIdx(next);
              onJump(insight.frameIndices[next]);
            }}
            className="text-app-micro text-app-text-muted hover:text-app-text px-1"
          >
            ›
          </button>
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
