import { useRef, type ReactNode } from "react";
import {
  Sparkles, RefreshCw, Gauge, Sliders, AlertTriangle,
  Lightbulb, Wrench, Download, Trash2, CircleDot, Zap,
} from "lucide-react";

export interface AnalysisHighlight {
  startFrac: number;
  endFrac: number;
  color: "good" | "warning" | "critical";
  label: string;
}

export interface PaceItem { label: string; value: string; assessment: "good" | "warning" | "critical"; detail: string }
export interface HandlingItem { label: string; value: string; assessment: "good" | "warning" | "critical"; detail: string }
export interface CornerItem { name: string; issue: string; fix: string; severity: "minor" | "moderate" | "major" }
export interface CornerBrakingItem { corner: string; assessment: "good" | "warning" | "critical"; brakePoint: string; detail: string }
export interface CornerThrottleItem { corner: string; assessment: "good" | "warning" | "critical"; throttlePoint: string; detail: string }
export interface CoachingItem { tip: string; detail: string }
export interface SetupItem { component: string; symptom: string; fix: string; current: string; target: string; direction: "increase" | "decrease" | "adjust" }

export interface AnalysisData {
  verdict: string;
  pace: PaceItem[];
  handling: HandlingItem[];
  corners: CornerItem[];
  braking: CornerBrakingItem[];
  throttle: CornerThrottleItem[];
  coaching: CoachingItem[];
  setup: SetupItem[];
}

export interface Segment {
  type: string;
  name: string;
  startFrac: number;
  endFrac: number;
}

export interface AnalysisUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  model: string;
}

export const ASSESSMENT_COLORS = { good: "text-emerald-400", warning: "text-amber-400", critical: "text-red-400" } as const;
export const ASSESSMENT_BG = { good: "bg-emerald-400/10 border-emerald-400/20", warning: "bg-amber-400/10 border-amber-400/20", critical: "bg-red-400/10 border-red-400/20" } as const;
export const SEVERITY_COLORS = { minor: "bg-app-text-dim", moderate: "bg-amber-500", major: "bg-red-500" } as const;

/** Find a segment whose name matches any of the search strings. */
export function findSegment(segments: Segment[] | null | undefined, ...texts: string[]): Segment | null {
  if (!segments || segments.length === 0) return null;
  const combined = texts.join(" ").toLowerCase();
  for (const s of segments) {
    const sn = s.name.toLowerCase();
    if (combined.includes(sn) || sn.includes(combined)) return s;
  }
  const words = combined.split(/\s+/).filter((w) => w.length > 2);
  for (const s of segments) {
    const sn = s.name.toLowerCase();
    if (words.some((w) => sn.includes(w))) return s;
  }
  return null;
}

export function MetricCard({ item }: { item: PaceItem | HandlingItem }) {
  return (
    <div className={`rounded-lg border px-2.5 py-1.5 ${ASSESSMENT_BG[item.assessment]}`}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] text-app-text-secondary uppercase tracking-wide">{item.label}</span>
        <span className={`text-[11px] font-mono font-semibold ${ASSESSMENT_COLORS[item.assessment]}`}>{item.value}</span>
      </div>
      <p className="text-[10px] text-app-text-secondary mt-0.5 leading-relaxed">{item.detail}</p>
    </div>
  );
}

export function TuneBar({ current, target }: { current: number; target: number }) {
  const lo = Math.min(current, target);
  const hi = Math.max(current, target);
  const spread = hi - lo || 1;
  const min = Math.max(0, lo - spread * 1.5);
  const max = hi + spread * 1.5;
  const range = max - min || 1;
  const currentPct = ((current - min) / range) * 100;
  const targetPct = ((target - min) / range) * 100;
  return (
    <div className="relative h-3 mt-1 mb-0.5">
      <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 bg-app-border-input/50 rounded-full" />
      <div className="absolute top-1/2 -translate-y-1/2 h-1 bg-amber-400/20 rounded-full" style={{ left: `${Math.min(currentPct, targetPct)}%`, width: `${Math.abs(targetPct - currentPct)}%` }} />
      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2" style={{ left: `${currentPct}%` }}>
        <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-t-[6px] border-l-transparent border-r-transparent border-t-cyan-400" />
      </div>
      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2" style={{ left: `${targetPct}%` }}>
        <div className="w-0 h-0 border-l-[4px] border-r-[4px] border-b-[6px] border-l-transparent border-r-transparent border-b-amber-400" />
      </div>
    </div>
  );
}

/** Wrapper that makes a card clickable to highlight a track zone. */
export function TrackCard({
  seg, color, onJumpToFrac, onHighlightsChange, className, children,
}: {
  seg: Segment | null;
  color: "good" | "warning" | "critical";
  onJumpToFrac?: (frac: number) => void;
  onHighlightsChange?: (h: AnalysisHighlight[]) => void;
  className?: string;
  children: ReactNode;
}) {
  const clickable = !!(seg && onJumpToFrac);
  return (
    <div
      className={`${className ?? ""} ${clickable ? "cursor-pointer hover:brightness-110 transition" : ""}`}
      onClick={() => {
        if (!seg) return;
        onJumpToFrac?.((seg.startFrac + seg.endFrac) / 2);
        onHighlightsChange?.([{ startFrac: seg.startFrac, endFrac: seg.endFrac, color, label: seg.name }]);
      }}
    >
      {children}
    </div>
  );
}

export function SectionHeader({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-2">
      <span className="text-app-text-secondary">{icon}</span>
      <h3 className="text-[10px] font-semibold text-app-text uppercase tracking-wider">{title}</h3>
    </div>
  );
}

/**
 * Renders the structured analysis cards (verdict, pace, handling, corners, braking,
 * throttle, coaching, setup) plus an optional actions bar. Used by the analyse-view
 * AiPanel and the compare-view analysis modal.
 */
export function AnalysisDisplay({
  analysis,
  cornerFracs,
  segments,
  hasTune,
  usage,
  onJumpToFrac,
  onHighlightsChange,
  onExport,
  onRegenerate,
  onClear,
  loading,
  containerRef,
}: {
  analysis: AnalysisData;
  cornerFracs?: Segment[];
  segments?: Segment[] | null;
  hasTune?: boolean;
  usage?: AnalysisUsage | null;
  onJumpToFrac?: (frac: number) => void;
  onHighlightsChange?: (h: AnalysisHighlight[]) => void;
  onExport?: () => void;
  onRegenerate?: () => void;
  onClear?: () => void;
  loading?: boolean;
  containerRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = containerRef ?? internalRef;
  const lookupSegs = (cornerFracs && cornerFracs.length > 0) ? cornerFracs : (segments ?? null);

  return (
    <div ref={ref} className="max-w-full rounded-lg px-2.5 py-2 bg-app-surface-alt/60 border border-app-border-input/40 text-app-text-secondary space-y-3">
      {/* Verdict */}
      <p className="text-[11px] text-app-text leading-relaxed">{analysis.verdict}</p>

      {/* Pace */}
      {analysis.pace?.length > 0 && (
        <div>
          <SectionHeader icon={<Gauge className="size-3" />} title="Pace" />
          <div className="grid grid-cols-1 gap-1.5">{analysis.pace.map((item, i) => <MetricCard key={i} item={item} />)}</div>
        </div>
      )}

      {/* Handling */}
      {analysis.handling?.length > 0 && (
        <div>
          <SectionHeader icon={<Sliders className="size-3" />} title="Handling" />
          <div className="grid grid-cols-1 gap-1.5">{analysis.handling.map((item, i) => <MetricCard key={i} item={item} />)}</div>
        </div>
      )}

      {/* Problem Corners */}
      {analysis.corners?.length > 0 && (
        <div>
          <SectionHeader icon={<AlertTriangle className="size-3" />} title="Problem Corners" />
          <div className="space-y-1.5">
            {analysis.corners.map((corner, i) => (
              <TrackCard key={i} seg={findSegment(lookupSegs, corner.name)} color={corner.severity === "major" ? "critical" : corner.severity === "moderate" ? "warning" : "good"} onJumpToFrac={onJumpToFrac} onHighlightsChange={onHighlightsChange} className="bg-app-surface-alt/40 border border-app-border-input/40 rounded-lg px-2.5 py-2">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className={`size-1.5 rounded-full ${SEVERITY_COLORS[corner.severity]}`} />
                  <span className="text-[11px] font-semibold text-app-text">{corner.name}</span>
                </div>
                <p className="text-[10px] text-app-text-secondary">{corner.issue}</p>
                <p className="text-[10px] text-emerald-400/80 mt-0.5">{corner.fix}</p>
              </TrackCard>
            ))}
          </div>
        </div>
      )}

      {/* Braking per corner */}
      {analysis.braking?.length > 0 && (
        <div>
          <SectionHeader icon={<CircleDot className="size-3" />} title="Braking Points" />
          <div className="space-y-1.5">
            {analysis.braking.map((item, i) => (
              <TrackCard key={i} seg={findSegment(lookupSegs, item.corner)} color={item.assessment} onJumpToFrac={onJumpToFrac} onHighlightsChange={onHighlightsChange} className={`rounded-lg border px-2.5 py-1.5 ${ASSESSMENT_BG[item.assessment]}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] font-semibold text-app-text">{item.corner}</span>
                  <span className={`text-[10px] font-mono ${ASSESSMENT_COLORS[item.assessment]}`}>{item.brakePoint}</span>
                </div>
                <p className="text-[10px] text-app-text-secondary mt-0.5">{item.detail}</p>
              </TrackCard>
            ))}
          </div>
        </div>
      )}

      {/* Throttle per corner */}
      {analysis.throttle?.length > 0 && (
        <div>
          <SectionHeader icon={<Zap className="size-3" />} title="Throttle Application" />
          <div className="space-y-1.5">
            {analysis.throttle.map((item, i) => (
              <TrackCard key={i} seg={findSegment(lookupSegs, item.corner)} color={item.assessment} onJumpToFrac={onJumpToFrac} onHighlightsChange={onHighlightsChange} className={`rounded-lg border px-2.5 py-1.5 ${ASSESSMENT_BG[item.assessment]}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-[11px] font-semibold text-app-text">{item.corner}</span>
                  <span className={`text-[10px] font-mono ${ASSESSMENT_COLORS[item.assessment]}`}>{item.throttlePoint}</span>
                </div>
                <p className="text-[10px] text-app-text-secondary mt-0.5">{item.detail}</p>
              </TrackCard>
            ))}
          </div>
        </div>
      )}

      {/* Coaching */}
      {analysis.coaching?.length > 0 && (
        <div>
          <SectionHeader icon={<Lightbulb className="size-3" />} title="Coaching" />
          <div className="space-y-1.5">
            {analysis.coaching.map((item, i) => (
              <TrackCard key={i} seg={findSegment(lookupSegs, item.tip, item.detail)} color="warning" onJumpToFrac={onJumpToFrac} onHighlightsChange={onHighlightsChange} className="flex gap-2">
                <span className="text-amber-400/60 text-[10px] font-mono mt-0.5">{i + 1}.</span>
                <div>
                  <span className="text-[11px] font-medium text-app-text">{item.tip}</span>
                  <p className="text-[10px] text-app-text-secondary mt-0.5">{item.detail}</p>
                </div>
              </TrackCard>
            ))}
          </div>
        </div>
      )}

      {/* Setup */}
      {analysis.setup?.length > 0 && (
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <span className="text-app-text-secondary"><Wrench className="size-3" /></span>
            <h3 className="text-[10px] font-semibold text-app-text uppercase tracking-wider">Setup</h3>
            {!hasTune && <span className="text-[8px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-400/15 text-amber-400 border border-amber-400/20">Best Guess</span>}
          </div>
          {!hasTune && (
            <p className="text-[9px] text-amber-400/70 mb-1.5 leading-snug">No tune data linked — values are estimated from telemetry. Link a tune for accurate setup suggestions.</p>
          )}
          <div className="grid grid-cols-1 gap-1.5">
            {analysis.setup.map((item, i) => {
              const extractNum = (s?: string) => { const m = s?.match(/-?\d+\.?\d*/); return m ? parseFloat(m[0]) : NaN; };
              const currentNum = extractNum(item.current);
              const targetNum = extractNum(item.target);
              const hasBoth = !isNaN(currentNum) && !isNaN(targetNum) && currentNum !== targetNum;
              return (
                <TrackCard key={i} seg={findSegment(lookupSegs, item.symptom, item.fix)} color="warning" onJumpToFrac={onJumpToFrac} onHighlightsChange={onHighlightsChange} className="bg-app-surface-alt/40 border border-app-border-input/40 rounded-lg px-2.5 py-2">
                  <span className="text-[11px] font-semibold text-app-text block mb-1">{item.component}</span>
                  <span className={`text-[9px] font-mono px-1 py-0.5 rounded ${
                    item.direction === "increase" ? "bg-emerald-400/10 text-emerald-400" :
                    item.direction === "decrease" ? "bg-red-400/10 text-red-400" :
                    "bg-amber-400/10 text-amber-400"
                  }`}>{item.current} → {item.target}</span>
                  {hasBoth && <TuneBar current={currentNum} target={targetNum} />}
                  <p className="text-[10px] text-app-text-secondary mt-1"><span className="text-red-400/70">Symptom:</span> {item.symptom}</p>
                  <p className="text-[10px] text-app-text-secondary mt-0.5"><span className="text-emerald-400/70">Fix:</span> {item.fix}</p>
                </TrackCard>
              );
            })}
          </div>
        </div>
      )}

      {/* Actions bar */}
      {(usage || onExport || onRegenerate || onClear) && (
        <div className="flex items-center gap-1.5 pt-1.5 border-t border-app-border-input/30">
          {usage && (
            <span className="text-[9px] text-app-text-muted font-mono mr-auto">
              {usage.inputTokens.toLocaleString()}↓ {usage.outputTokens.toLocaleString()}↑ ${usage.costUsd.toFixed(4)} {(usage.durationMs / 1000).toFixed(1)}s
            </span>
          )}
          {onExport && (
            <button onClick={onExport} className="flex items-center gap-1 text-[9px] text-app-text-muted hover:text-app-text px-1.5 py-0.5 rounded border border-transparent hover:border-app-border-input transition-colors" title="Export as image">
              <Download className="size-3" /> Export
            </button>
          )}
          {onRegenerate && (
            <button onClick={onRegenerate} disabled={loading} className="flex items-center gap-1 text-[9px] text-app-text-muted hover:text-app-text px-1.5 py-0.5 rounded border border-transparent hover:border-app-border-input transition-colors disabled:opacity-50" title="Regenerate analysis">
              <RefreshCw className="size-3" /> Regenerate
            </button>
          )}
          {onClear && (
            <button onClick={onClear} className="flex items-center gap-1 text-[9px] text-app-text-muted hover:text-red-400 px-1.5 py-0.5 rounded border border-transparent hover:border-app-border-input transition-colors" title="Clear analysis and chat">
              <Trash2 className="size-3" /> Clear
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Re-export the Sparkles icon used by callers as a convenience
export { Sparkles };
