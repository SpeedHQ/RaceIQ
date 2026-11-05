import { AlertTriangle, CircleDot, Download, Gauge, Lightbulb, RefreshCw, Sliders, Trash2, Zap } from "lucide-react";
import { useMemo, useRef } from "react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { parseCornerActions, type CornerAction } from "@raceiq/lap-replay/contracts";
import { useCornerFocusController } from "@raceiq/lap-replay/ui";
import { CornerActionText } from "./CornerActionText";
import { MetricCard, SectionHeader, TrackCard } from "./analysis-primitives";
import type { AnalysisData, AnalysisHighlight, AnalysisUsage, Segment } from "./analysis-types";
import { ASSESSMENT_BG, ASSESSMENT_COLORS, findSegment, SEVERITY_COLORS } from "./analysis-utils";
import { getLocale } from "@/paraglide/runtime";

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
  focusTarget = "solo",
  lapId,
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
  focusTarget?: CornerAction["target"];
  /** Loaded replay lap; a stale analysis must never seek it. */
  lapId?: number | null;
}) {
  const internalRef = useRef<HTMLDivElement>(null);
  const ref = containerRef ?? internalRef;
  const lookupSegs = cornerFracs && cornerFracs.length > 0 ? cornerFracs : (segments ?? null);
  const staleAnalysis = analysis.lapId != null && lapId != null && analysis.lapId !== lapId;
  const actions = useMemo(() => (staleAnalysis ? [] : parseCornerActions(analysis.actions)), [analysis.actions, staleAnalysis]);
  const cornerFocus = useCornerFocusController();
  const focusEnabled = cornerFocus.enabled && !staleAnalysis;
  const inline = (text: string, path: string) => {
    const matching = actions.filter((action) => action.path === path);
    return matching.length > 0 ? <CornerActionText text={text} actions={matching} /> : text;
  };
  const focusSegment = (seg: Segment | null) => {
    if (!seg || !focusEnabled) return false;
    const range = /^T(\d+(?:-\d+)?)/i.exec(seg.name);
    const cornerKey = typeof seg.number === "number" ? `t${seg.number}` : range ? `t${range[1]}` : seg.name;
    return cornerFocus.focus({
      id: `card:${cornerKey}`,
      cornerKey,
      label: seg.name,
      target: focusTarget,
      span: { start: 0, end: 1 },
    }, { loop: false });
  };

  return (
    <div ref={ref} className="flex max-w-full flex-col gap-3 rounded-lg border border-app-border-input/40 bg-app-surface-alt/60 px-2.5 py-2 text-app-text-secondary">
      <p className="text-app-compact text-app-text leading-relaxed">{inline(analysis.verdict, "verdict")}</p>
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
      {analysis.corners?.length > 0 && (
        <div>
          <SectionHeader icon={<AlertTriangle className="size-3" />} title={m.label_problem_corners()} />
          <div className="flex flex-col gap-1.5">
            {analysis.corners.map((corner, index) => (
              <TrackCard
                key={corner.name}
                seg={findSegment(lookupSegs, corner.name)}
                color={corner.severity === "major" ? "critical" : corner.severity === "moderate" ? "warning" : "good"}
                onJumpToFrac={onJumpToFrac}
                onFocusCorner={focusEnabled ? () => focusSegment(findSegment(lookupSegs, corner.name)) : undefined}
                onHighlightsChange={onHighlightsChange}
                className="bg-app-surface-alt/40 border border-app-border-input/40 rounded-lg px-2.5 py-2"
              >
                <div className="flex items-center gap-1.5 mb-0.5">
                  <span className={`size-1.5 rounded-full ${SEVERITY_COLORS[corner.severity]}`} />
                  <span className="text-app-compact font-semibold text-app-text">{corner.name}</span>
                </div>
                <p className="text-app-caption text-app-text-secondary">{inline(corner.issue, `corners[${index}].issue`)}</p>
                <p className="text-app-caption text-(--delta-gain)/80 mt-0.5">{inline(corner.fix, `corners[${index}].fix`)}</p>
              </TrackCard>
            ))}
          </div>
        </div>
      )}
      {analysis.braking?.length > 0 && (
        <div>
          <SectionHeader icon={<CircleDot className="size-3" />} title={m.label_braking_points()} />
          <div className="flex flex-col gap-1.5">
            {analysis.braking.map((item, index) => (
              <TrackCard
                key={item.corner}
                seg={findSegment(lookupSegs, item.corner)}
                color={item.assessment}
                onJumpToFrac={onJumpToFrac}
                onFocusCorner={focusEnabled ? () => focusSegment(findSegment(lookupSegs, item.corner)) : undefined}
                onHighlightsChange={onHighlightsChange}
                className={`rounded-lg border px-2.5 py-1.5 ${ASSESSMENT_BG[item.assessment]}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-app-compact font-semibold text-app-text">{item.corner}</span>
                  <span className={`text-app-caption font-mono ${ASSESSMENT_COLORS[item.assessment]}`}>{item.brakePoint}</span>
                </div>
                <p className="text-app-caption text-app-text-secondary mt-0.5">{inline(item.detail, `braking[${index}].detail`)}</p>
              </TrackCard>
            ))}
          </div>
        </div>
      )}
      {analysis.throttle?.length > 0 && (
        <div>
          <SectionHeader icon={<Zap className="size-3" />} title={m.label_throttle_application()} />
          <div className="flex flex-col gap-1.5">
            {analysis.throttle.map((item, index) => (
              <TrackCard
                key={item.corner}
                seg={findSegment(lookupSegs, item.corner)}
                color={item.assessment}
                onJumpToFrac={onJumpToFrac}
                onFocusCorner={focusEnabled ? () => focusSegment(findSegment(lookupSegs, item.corner)) : undefined}
                onHighlightsChange={onHighlightsChange}
                className={`rounded-lg border px-2.5 py-1.5 ${ASSESSMENT_BG[item.assessment]}`}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-app-compact font-semibold text-app-text">{item.corner}</span>
                  <span className={`text-app-caption font-mono ${ASSESSMENT_COLORS[item.assessment]}`}>{item.throttlePoint}</span>
                </div>
                <p className="text-app-caption text-app-text-secondary mt-0.5">{inline(item.detail, `throttle[${index}].detail`)}</p>
              </TrackCard>
            ))}
          </div>
        </div>
      )}
      {analysis.coaching?.length > 0 && (
        <div>
          <SectionHeader icon={<Lightbulb className="size-3" />} title={m.label_coaching()} />
          <div className="flex flex-col gap-1.5">
            {analysis.coaching.map((item, i) => (
              <TrackCard key={item.tip} seg={findSegment(lookupSegs, item.tip, item.detail)} color="warning" onJumpToFrac={onJumpToFrac} onFocusCorner={focusEnabled ? () => focusSegment(findSegment(lookupSegs, item.tip, item.detail)) : undefined} onHighlightsChange={onHighlightsChange} className="flex gap-2">
                <span className="text-ai-accent/60 text-app-caption font-mono mt-0.5">{i + 1}.</span>
                <div>
                  <span className="text-app-compact font-medium text-app-text">{inline(item.tip, `technique[${i}].tip`)}</span>
                  <p className="text-app-caption text-app-text-secondary mt-0.5">{inline(item.detail, `technique[${i}].detail`)}</p>
                </div>
              </TrackCard>
            ))}
          </div>
        </div>
      )}
      {(usage || onExport || onRegenerate || onClear) && (
        <div className="flex items-center gap-1.5 pt-1.5 border-t border-app-border-input/30">
          {usage && (
            <span className="text-app-micro text-app-text-muted font-mono mr-auto">
              {usage.inputTokens.toLocaleString(getLocale())}↓ {usage.outputTokens.toLocaleString(getLocale())}↑ ${usage.costUsd.toFixed(4)} {(usage.durationMs / 1000).toFixed(1)}s
            </span>
          )}
          {onExport && (
            <Button type="button" variant="app-ghost" size="app-sm" onClick={onExport} title={m.label_export_as_image()}>
              <Download data-icon="inline-start" /> {m.label_export()}
            </Button>
          )}
          {onRegenerate && (
            <Button type="button" variant="app-ghost" size="app-sm" onClick={onRegenerate} disabled={loading} title={m.aidisplay_regenerate()}>
              <RefreshCw data-icon="inline-start" /> {m.label_regenerate()}
            </Button>
          )}
          {onClear && (
            <Button type="button" variant="destructive-outline" size="app-sm" onClick={onClear} title={m.aipanel_clear_title()}>
              <Trash2 data-icon="inline-start" /> {m.label_clear()}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
