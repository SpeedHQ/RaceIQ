import { AlertTriangle, CircleDot, Download, Gauge, Lightbulb, RefreshCw, Sliders, Sparkles, Trash2, Zap } from "lucide-react";
import { type ReactNode, useRef } from "react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
export interface AnalysisHighlight {
  startFrac: number;
  endFrac: number;
  color: "good" | "warning" | "critical";
  label: string;
}

export interface PaceItem {
  label: string;
  value: string;
  assessment: "good" | "warning" | "critical";
  detail: string;
}
export interface HandlingItem {
  label: string;
  value: string;
  assessment: "good" | "warning" | "critical";
  detail: string;
}
export interface CornerItem {
  name: string;
  issue: string;
  fix: string;
  severity: "minor" | "moderate" | "major";
}
export interface CornerBrakingItem {
  corner: string;
  assessment: "good" | "warning" | "critical";
  brakePoint: string;
  detail: string;
}
export interface CornerThrottleItem {
  corner: string;
  assessment: "good" | "warning" | "critical";
  throttlePoint: string;
  detail: string;
}
export interface CoachingItem {
  tip: string;
  detail: string;
}
export interface SetupItem {
  component: string;
  symptom: string;
  fix: string;
  current: string;
  target: string;
  direction: "increase" | "decrease" | "adjust";
}

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

export const ASSESSMENT_COLORS = { good: "text-(--severity-nominal)", warning: "text-(--severity-caution)", critical: "text-(--severity-critical)" } as const;
export const ASSESSMENT_BG = {
  good: "bg-(--severity-nominal)/10 border-(--severity-nominal)/20",
  warning: "bg-(--severity-caution)/10 border-(--severity-caution)/20",
  critical: "bg-(--severity-critical)/10 border-(--severity-critical)/20",
} as const;
export const SEVERITY_COLORS = { minor: "bg-app-text-dim", moderate: "bg-(--severity-caution)", major: "bg-(--severity-critical)" } as const;

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

// Some local models emit snake_case/camelCase labels ("front_tyre_temp",
// "fullThrottleTime") regardless of prompt guidance. Normalise to spaces so
// the uppercase-styled header reads cleanly.
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

// F1 2025 (and common FM) setup field ranges. Key is a normalised
// component label (lowercased, no spaces/punct) so "Front Wing", "FrontWing",
// "front-wing" all collide. Falls back to auto-scale when not found so we
// don't break FM or unknown labels.
// F1 25 official setup slider bounds.
const FIELD_RANGES: Record<string, { min: number; max: number }> = {
  // Aero
  frontwing: { min: 0, max: 50 },
  rearwing: { min: 0, max: 50 },
  fuelload: { min: 5, max: 100 },
  // Transmission
  onthrottle: { min: 10, max: 100 },
  offthrottle: { min: 10, max: 100 },
  differentialonthrottle: { min: 10, max: 100 },
  differentialoffthrottle: { min: 10, max: 100 },
  enginebraking: { min: 0, max: 100 },
  // Suspension geometry
  frontcamber: { min: -3.5, max: -2.5 },
  rearcamber: { min: -2.0, max: -1.0 },
  fronttoe: { min: 0, max: 0.1 },
  reartoe: { min: 0, max: 0.4 },
  fronttoeout: { min: 0, max: 0.1 },
  reartoein: { min: 0, max: 0.4 },
  // Suspension
  frontsuspension: { min: 1, max: 41 },
  rearsuspension: { min: 1, max: 41 },
  frontantirollbar: { min: 1, max: 41 },
  rearantirollbar: { min: 1, max: 41 },
  frontrideheight: { min: 20, max: 50 },
  rearrideheight: { min: 20, max: 50 },
  // Brakes
  brakepressure: { min: 80, max: 100 },
  brakebias: { min: 50, max: 70 },
  frontbrakebias: { min: 50, max: 70 },
  // Tyres (psi)
  fronttyrepressure: { min: 22.0, max: 29.5 },
  reartyrepressure: { min: 20.0, max: 26.5 },
  frontlefttyrepressure: { min: 22.0, max: 29.5 },
  frontrighttyrepressure: { min: 22.0, max: 29.5 },
  rearlefttyrepressure: { min: 20.0, max: 26.5 },
  rearrighttyrepressure: { min: 20.0, max: 26.5 },
};

function lookupFieldRange(component: string | undefined): { min: number; max: number } | null {
  if (!component) return null;
  const key = component.toLowerCase().replace(/[^a-z0-9]/g, "");
  return FIELD_RANGES[key] ?? null;
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
    // Previously floored at 0 which broke negative fields like camber
    // (current -3.40° → target -3.30°) by clamping min to 0 and pushing both
    // markers off the right edge. Let min float naturally around the values.
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

/** Wrapper that makes a card clickable to highlight a track zone. */
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

/**
 * The setup recommendations themselves — just the list. Hosts decide where it
 * lives; the analysis modal renders it as a tab rather than stacking a second
 * modal on top of itself.
 */
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

/**
 * Renders the structured analysis cards (verdict, pace, handling, corners,
 * braking, throttle, coaching) plus an optional actions bar. Setup is not
 * included — it is a sibling tab in the analysis modal, rendered by SetupList.
 */
export function AnalysisDisplay({
  analysis,
  cornerFracs,
  segments,
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
  const lookupSegs = cornerFracs && cornerFracs.length > 0 ? cornerFracs : (segments ?? null);

  return (
    <div ref={ref} className="max-w-full rounded-lg px-2.5 py-2 bg-app-surface-alt/60 border border-app-border-input/40 text-app-text-secondary space-y-3">
      {/* Verdict */}
      <p className="text-app-compact text-app-text leading-relaxed">{analysis.verdict}</p>

      {/* Pace */}
      {analysis.pace?.length > 0 && (
        <div>
          <SectionHeader icon={<Gauge className="size-3" />} title={m.label_pace()} />
          <div className="grid grid-cols-1 gap-1.5">
            {analysis.pace.map((item) => (
              <MetricCard key={item.label} item={item} />
            ))}
          </div>
        </div>
      )}

      {/* Handling */}
      {analysis.handling?.length > 0 && (
        <div>
          <SectionHeader icon={<Sliders className="size-3" />} title={m.label_handling()} />
          <div className="grid grid-cols-1 gap-1.5">
            {analysis.handling.map((item) => (
              <MetricCard key={item.label} item={item} />
            ))}
          </div>
        </div>
      )}

      {/* Problem Corners */}
      {analysis.corners?.length > 0 && (
        <div>
          <SectionHeader icon={<AlertTriangle className="size-3" />} title={m.label_problem_corners()} />
          <div className="space-y-1.5">
            {analysis.corners.map((corner) => (
              <TrackCard
                key={corner.name}
                seg={findSegment(lookupSegs, corner.name)}
                color={corner.severity === "major" ? "critical" : corner.severity === "moderate" ? "warning" : "good"}
                onJumpToFrac={onJumpToFrac}
                onHighlightsChange={onHighlightsChange}
                className="bg-app-surface-alt/40 border border-app-border-input/40 rounded-lg px-2.5 py-2"
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className={`size-1.5 rounded-full ${SEVERITY_COLORS[corner.severity]}`} />
                  <span className="text-app-compact font-semibold text-app-text">{corner.name}</span>
                </div>
                <p className="text-app-caption text-app-text-secondary">{corner.issue}</p>
                <p className="text-app-caption text-(--delta-gain)/80 mt-0.5">{corner.fix}</p>
              </TrackCard>
            ))}
          </div>
        </div>
      )}

      {/* Braking per corner */}
      {analysis.braking?.length > 0 && (
        <div>
          <SectionHeader icon={<CircleDot className="size-3" />} title={m.label_braking_points()} />
          <div className="space-y-1.5">
            {analysis.braking.map((item) => (
              <TrackCard
                key={item.corner}
                seg={findSegment(lookupSegs, item.corner)}
                color={item.assessment}
                onJumpToFrac={onJumpToFrac}
                onHighlightsChange={onHighlightsChange}
                className={`rounded-lg border px-2.5 py-1.5 ${ASSESSMENT_BG[item.assessment]}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-app-compact font-semibold text-app-text">{item.corner}</span>
                  <span className={`text-app-caption font-mono ${ASSESSMENT_COLORS[item.assessment]}`}>{item.brakePoint}</span>
                </div>
                <p className="text-app-caption text-app-text-secondary mt-0.5">{item.detail}</p>
              </TrackCard>
            ))}
          </div>
        </div>
      )}

      {/* Throttle per corner */}
      {analysis.throttle?.length > 0 && (
        <div>
          <SectionHeader icon={<Zap className="size-3" />} title={m.label_throttle_application()} />
          <div className="space-y-1.5">
            {analysis.throttle.map((item) => (
              <TrackCard
                key={item.corner}
                seg={findSegment(lookupSegs, item.corner)}
                color={item.assessment}
                onJumpToFrac={onJumpToFrac}
                onHighlightsChange={onHighlightsChange}
                className={`rounded-lg border px-2.5 py-1.5 ${ASSESSMENT_BG[item.assessment]}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-app-compact font-semibold text-app-text">{item.corner}</span>
                  <span className={`text-app-caption font-mono ${ASSESSMENT_COLORS[item.assessment]}`}>{item.throttlePoint}</span>
                </div>
                <p className="text-app-caption text-app-text-secondary mt-0.5">{item.detail}</p>
              </TrackCard>
            ))}
          </div>
        </div>
      )}

      {/* Coaching */}
      {analysis.coaching?.length > 0 && (
        <div>
          <SectionHeader icon={<Lightbulb className="size-3" />} title={m.label_coaching()} />
          <div className="space-y-1.5">
            {analysis.coaching.map((item, i) => (
              <TrackCard key={item.tip} seg={findSegment(lookupSegs, item.tip, item.detail)} color="warning" onJumpToFrac={onJumpToFrac} onHighlightsChange={onHighlightsChange} className="flex gap-2">
                <span className="text-ai-accent/60 text-app-caption font-mono mt-0.5">
                  {i + 1}.
                </span>
                <div>
                  <span className="text-app-compact font-medium text-app-text">{item.tip}</span>
                  <p className="text-app-caption text-app-text-secondary mt-0.5">{item.detail}</p>
                </div>
              </TrackCard>
            ))}
          </div>
        </div>
      )}

      {/* Setup lives in its own tab alongside this card — see AnalysisModalShell. */}

      {/* Actions bar */}
      {(usage || onExport || onRegenerate || onClear) && (
        <div className="flex items-center gap-1.5 pt-1.5 border-t border-app-border-input/30">
          {usage && (
            <span className="text-app-micro text-app-text-muted font-mono mr-auto">
              {usage.inputTokens.toLocaleString()}↓ {usage.outputTokens.toLocaleString()}↑ ${usage.costUsd.toFixed(4)} {(usage.durationMs / 1000).toFixed(1)}s
            </span>
          )}
          {onExport && (
            <Button
              type="button"
              variant="app-ghost"
              size="app-sm"
              onClick={onExport}
              className="border border-transparent hover:border-app-border-hover"
              title={m.label_export_as_image()}
            >
              <Download className="size-3" /> {m.label_export()}
            </Button>
          )}
          {onRegenerate && (
            <Button
              type="button"
              variant="app-ghost"
              size="app-sm"
              onClick={onRegenerate}
              disabled={loading}
              className="border border-transparent hover:border-app-border-hover"
              title={m.aidisplay_regenerate()}
            >
              <RefreshCw className="size-3" /> {m.label_regenerate()}
            </Button>
          )}
          {onClear && (
            <Button
              type="button"
              variant="app-danger"
              size="app-sm"
              onClick={onClear}
              title={m.aipanel_clear_title()}
            >
              <Trash2 className="size-3" /> {m.label_clear()}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

// Re-export the Sparkles icon used by callers as a convenience
export { Sparkles };
