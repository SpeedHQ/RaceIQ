import { useState } from "react";
import type { LapInsight, InsightCategory } from "../lib/lap-insights";

const CATEGORIES: { key: InsightCategory; icon: string; label: string }[] = [
  { key: "suspension", icon: "🔧", label: "Suspension" },
  { key: "tires", icon: "🛞", label: "Tires" },
  { key: "driving", icon: "🏎️", label: "Driving" },
  { key: "mechanical", icon: "⚙️", label: "Mechanical" },
];

const SEVERITY_COLOR: Record<string, string> = {
  info: "#94a3b8",
  warning: "#fbbf24",
  critical: "#ef4444",
};

function InsightRow({
  insight,
  onJump,
}: {
  insight: LapInsight;
  onJump: (idx: number) => void;
}) {
  const [eventIdx, setEventIdx] = useState(0);
  const hasMultiple = insight.frameIndices.length > 1;

  return (
    <button
      onClick={() => onJump(insight.frameIndices[eventIdx])}
      className="w-full text-left px-2 py-1.5 rounded hover:bg-app-surface-alt/60 transition-colors group"
    >
      <div className="flex items-start gap-1.5">
        <span
          className="mt-1 w-1.5 h-1.5 rounded-full shrink-0"
          style={{ backgroundColor: SEVERITY_COLOR[insight.severity] }}
        />
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-mono text-app-text group-hover:text-app-text">
            {insight.label}
          </div>
          <div className="text-[10px] text-app-text-muted">{insight.detail}</div>
        </div>
      </div>
      {hasMultiple && (
        <div className="flex items-center gap-1 mt-1 ml-3">
          <button
            onClick={(e) => {
              e.stopPropagation();
              const prev = (eventIdx - 1 + insight.frameIndices.length) % insight.frameIndices.length;
              setEventIdx(prev);
              onJump(insight.frameIndices[prev]);
            }}
            className="text-[9px] text-app-text-muted hover:text-app-text px-1"
          >
            ‹
          </button>
          <span className="text-[9px] text-app-text-dim tabular-nums">
            {eventIdx + 1}/{insight.frameIndices.length}
          </span>
          <button
            onClick={(e) => {
              e.stopPropagation();
              const next = (eventIdx + 1) % insight.frameIndices.length;
              setEventIdx(next);
              onJump(insight.frameIndices[next]);
            }}
            className="text-[9px] text-app-text-muted hover:text-app-text px-1"
          >
            ›
          </button>
        </div>
      )}
    </button>
  );
}

export function InsightPanel({
  insights,
  onJumpToFrame,
}: {
  insights: LapInsight[];
  onJumpToFrame: (frameIdx: number) => void;
}) {
  return (
    <div className="space-y-3">
      {CATEGORIES.map(({ key, icon, label }) => {
        const items = insights.filter((i) => i.category === key);
        return (
          <div key={key}>
            <div className="flex items-center gap-1.5 mb-1">
              <span className="text-xs">{icon}</span>
              <h4 className="text-[10px] text-app-text-muted uppercase tracking-wider font-semibold">
                {label}
              </h4>
              {items.length > 0 && (
                <span className="text-[9px] bg-app-surface-alt text-app-text-secondary rounded-full px-1.5 tabular-nums">
                  {items.length}
                </span>
              )}
            </div>
            {items.length === 0 ? (
              <div className="text-[10px] text-app-text-dim pl-5">
                ✓ No issues detected
              </div>
            ) : (
              <div className="space-y-0.5">
                {items.map((insight) => (
                  <InsightRow
                    key={insight.id}
                    insight={insight}
                    onJump={onJumpToFrame}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
