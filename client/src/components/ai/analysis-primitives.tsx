import type { ReactNode } from "react";
import { m } from "@/paraglide/messages";
import type { AnalysisHighlight, HandlingItem, PaceItem, Segment, SetupItem } from "./analysis-types";
import { ASSESSMENT_BG, ASSESSMENT_COLORS, findSegment, lookupFieldRange } from "./analysis-utils";

function humanizeLabel(raw: string): string {
  return raw
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

export function MetricCard({ item }: { item: PaceItem | HandlingItem }) {
  return (
    <div className={`rounded-lg border px-2.5 py-1.5 ${ASSESSMENT_BG[item.assessment]}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-app-caption text-app-text-secondary uppercase tracking-wide">{humanizeLabel(item.label)}</span>
        <span className={`text-app-compact font-mono font-semibold ${ASSESSMENT_COLORS[item.assessment]}`}>{item.value}</span>
      </div>
      <p className="text-app-caption text-app-text-secondary mt-0.5 leading-relaxed">{item.detail}</p>
    </div>
  );
}

export function TuneBar({ current, target, component }: { current: number; target: number; component?: string }) {
  const known = lookupFieldRange(component);
  let min: number;
  let max: number;
  if (known) {
    min = known.min;
    max = known.max;
  } else {
    const lo = Math.min(current, target);
    const hi = Math.max(current, target);
    const spread = hi - lo || Math.max(Math.abs(hi) * 0.1, 1);
    min = lo - spread * 1.5;
    max = hi + spread * 1.5;
  }
  const range = max - min || 1;
  const clamp = (p: number) => Math.min(100, Math.max(0, p));
  const currentPct = clamp(((current - min) / range) * 100);
  const targetPct = clamp(((target - min) / range) * 100);
  return (
    <div className="relative h-3 mt-1 mb-0.5">
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-app-border-input/50 rounded-full" />
      <div
        className="absolute top-1/2 -translate-y-1/2 h-1 bg-(--tune-target)/20 rounded-full"
        style={{ left: `${Math.min(currentPct, targetPct)}%`, width: `${Math.abs(targetPct - currentPct)}%` }}
      />
      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2" style={{ left: `${currentPct}%` }}>
        <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px] border-l-transparent border-r-transparent border-t-(--tune-current)" />
      </div>
      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2" style={{ left: `${targetPct}%` }}>
        <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-b-[6px] border-l-transparent border-r-transparent border-b-(--tune-target)" />
      </div>
    </div>
  );
}

export function TrackCard({
  seg,
  color,
  onJumpToFrac,
  onHighlightsChange,
  className,
  children,
}: {
  seg: Segment | null;
  color: "good" | "warning" | "critical";
  onJumpToFrac?: (frac: number) => void;
  onHighlightsChange?: (h: AnalysisHighlight[]) => void;
  className?: string;
  children: ReactNode;
}) {
  const clickable = !!(seg && onJumpToFrac);
  const activate = () => {
    if (!seg) return;
    onJumpToFrac?.((seg.startFrac + seg.endFrac) / 2);
    onHighlightsChange?.([{ startFrac: seg.startFrac, endFrac: seg.endFrac, color, label: seg.name }]);
  };
  return (
    <div
      className={`${className ?? ""} ${clickable ? "cursor-pointer hover:brightness-110 transition" : ""}`}
      {...(clickable
        ? {
            role: "button" as const,
            tabIndex: 0,
            onClick: activate,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                activate();
              }
            },
          }
        : {})}
    >
      {children}
    </div>
  );
}

export function SectionHeader({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-2">
      <span className="text-app-text-secondary">{icon}</span>
      <h3 className="text-app-caption font-semibold text-app-text uppercase tracking-wider">{title}</h3>
    </div>
  );
}

export function SetupList({
  setup,
  hasTune,
  lookupSegs,
  onJumpToFrac,
  onHighlightsChange,
}: {
  setup: SetupItem[];
  hasTune?: boolean;
  lookupSegs: Segment[] | null;
  onJumpToFrac?: (frac: number) => void;
  onHighlightsChange?: (h: AnalysisHighlight[]) => void;
}) {
  return (
    <div className="space-y-2">
      {!hasTune && <p className="text-app-caption text-ai-accent/70 leading-snug">{m.aidisplay_no_tune_linked()}</p>}
      {setup.map((item) => {
        const extractNum = (s?: string) => {
          const match = s?.match(/-?\d+\.?\d*/);
          return match ? parseFloat(match[0]) : NaN;
        };
        const currentNum = extractNum(item.current);
        const targetNum = extractNum(item.target);
        const hasBoth = !Number.isNaN(currentNum) && !Number.isNaN(targetNum) && currentNum !== targetNum;
        return (
          <TrackCard
            key={`${item.component}-${item.symptom}`}
            seg={findSegment(lookupSegs, item.symptom, item.fix)}
            color="warning"
            onJumpToFrac={onJumpToFrac}
            onHighlightsChange={onHighlightsChange}
            className="bg-app-surface-alt/40 border border-app-border-input/40 rounded-lg px-3 py-2.5"
          >
            <span className="text-app-label font-semibold text-app-text block mb-1">{item.component}</span>
            <span
              className={`text-app-caption font-mono px-1.5 py-0.5 rounded ${
                item.direction === "increase"
                  ? "bg-(--delta-gain)/10 text-(--delta-gain)"
                  : item.direction === "decrease"
                    ? "bg-(--delta-loss)/10 text-(--delta-loss)"
                    : "bg-(--delta-focus)/10 text-(--delta-focus)"
              }`}
            >
              {item.current} → {item.target}
            </span>
            {hasBoth && <TuneBar current={currentNum} target={targetNum} component={item.component} />}
            <p className="text-app-compact text-app-text-secondary mt-1.5">
              <span className="text-(--delta-loss)/70">{m.aidisplay_symptom()}</span> {item.symptom}
            </p>
            <p className="text-app-compact text-app-text-secondary mt-0.5">
              <span className="text-(--delta-gain)/70">{m.aidisplay_fix()}</span> {item.fix}
            </p>
          </TrackCard>
        );
      })}
    </div>
  );
}
