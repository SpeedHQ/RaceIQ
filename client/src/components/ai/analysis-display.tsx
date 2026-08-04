import { AlertTriangle, CircleDot, Download, Gauge, Lightbulb, RefreshCw, Sliders, Trash2, Zap } from "lucide-react";
import { useRef } from "react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { MetricCard, SectionHeader, TrackCard } from "./analysis-primitives";
import type { AnalysisData, AnalysisHighlight, AnalysisUsage, Segment } from "./analysis-types";
import { ASSESSMENT_BG, ASSESSMENT_COLORS, findSegment, SEVERITY_COLORS } from "./analysis-utils";

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
      <p className="text-app-compact text-app-text leading-relaxed">{analysis.verdict}</p>
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
      {analysis.coaching?.length > 0 && (
        <div>
          <SectionHeader icon={<Lightbulb className="size-3" />} title={m.label_coaching()} />
          <div className="space-y-1.5">
            {analysis.coaching.map((item, i) => (
              <TrackCard key={item.tip} seg={findSegment(lookupSegs, item.tip, item.detail)} color="warning" onJumpToFrac={onJumpToFrac} onHighlightsChange={onHighlightsChange} className="flex gap-2">
                <span className="text-ai-accent/60 text-app-caption font-mono mt-0.5">{i + 1}.</span>
                <div>
                  <span className="text-app-compact font-medium text-app-text">{item.tip}</span>
                  <p className="text-app-caption text-app-text-secondary mt-0.5">{item.detail}</p>
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
              {usage.inputTokens.toLocaleString()}↓ {usage.outputTokens.toLocaleString()}↑ ${usage.costUsd.toFixed(4)} {(usage.durationMs / 1000).toFixed(1)}s
            </span>
          )}
          {onExport && (
            <Button
              type="button"
              onClick={onExport}
              className="flex items-center gap-1 text-app-micro text-app-text-muted hover:text-app-text px-1.5 py-0.5 rounded border border-transparent hover:border-app-border-hover transition-colors"
              title={m.label_export_as_image()}
            >
              <Download className="size-3" /> {m.label_export()}
            </Button>
          )}
          {onRegenerate && (
            <Button
              type="button"
              onClick={onRegenerate}
              disabled={loading}
              className="flex items-center gap-1 text-app-micro text-app-text-muted hover:text-app-text px-1.5 py-0.5 rounded border border-transparent hover:border-app-border-hover transition-colors disabled:opacity-50"
              title={m.aidisplay_regenerate()}
            >
              <RefreshCw className="size-3" /> {m.label_regenerate()}
            </Button>
          )}
          {onClear && (
            <Button
              type="button"
              onClick={onClear}
              className="flex items-center gap-1 text-app-micro text-app-text-muted hover:text-status-danger px-1.5 py-0.5 rounded border border-transparent hover:border-app-border-hover transition-colors"
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
