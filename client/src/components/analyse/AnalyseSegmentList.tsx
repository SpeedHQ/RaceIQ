import { memo, useMemo } from "react";
import { lapWrappedSegmentGroup, segmentDisplayNames } from "@shared/racing/tracks/segment-label";
import { m } from "@/paraglide/messages";
import type { SemanticAnalysisFrame } from "./track-map/types";

export type { SemanticAnalysisFrame } from "./track-map/types";

const numeric = (frame: SemanticAnalysisFrame, id: keyof SemanticAnalysisFrame["values"]): number | null => {
  const value = frame.values[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

interface Segment {
  type: string;
  name: string;
  group?: string;
  startFrac: number;
  endFrac: number;
}

interface SegmentListProps {
  telemetry: SemanticAnalysisFrame[];
  segments: Segment[] | null;
  cursorIdx: number;
}

export function buildSegmentData(telemetry: SemanticAnalysisFrame[], segments: Segment[]) {
  if (segments.length === 0 || telemetry.length < 10) return null;
  const n = telemetry.length;
  const cumDist = new Array<number>(n);
  cumDist[0] = 0;

  const firstDistance = numeric(telemetry[0], "timing.distance-traveled");
  const lastDistance = numeric(telemetry[n - 1], "timing.distance-traveled");
  const lapDistance = firstDistance != null && lastDistance != null ? lastDistance - firstDistance : null;
  if (lapDistance != null && lapDistance > 0) {
    for (let i = 1; i < n; i++) {
      const distance = numeric(telemetry[i], "timing.distance-traveled");
      const relative = distance != null && firstDistance != null ? distance - firstDistance : null;
      cumDist[i] = relative != null ? Math.max(cumDist[i - 1], relative) : cumDist[i - 1];
    }
  } else {
    for (let i = 1; i < n; i++) {
      const x = numeric(telemetry[i], "motion.position-x");
      const z = numeric(telemetry[i], "motion.position-z");
      const previousX = numeric(telemetry[i - 1], "motion.position-x");
      const previousZ = numeric(telemetry[i - 1], "motion.position-z");
      cumDist[i] = x != null && z != null && previousX != null && previousZ != null ? cumDist[i - 1] + Math.hypot(x - previousX, z - previousZ) : cumDist[i - 1];
    }
  }

  const totalDist = cumDist[n - 1];
  if (!(totalDist > 0)) return null;

  function fracToIdx(frac: number): number {
    const targetDist = frac * totalDist;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumDist[mid] < targetDist) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  const displayNames = segmentDisplayNames(segments);
  const staticSegments: {
    name: string;
    type: string;
    time: number;
    ranges: { startFrac: number; endFrac: number }[];
  }[] = [];
  for (let si = 0; si < segments.length; si++) {
    const seg = segments[si];
    const startIdx = fracToIdx(seg.startFrac);
    const endIdx = Math.min(fracToIdx(seg.endFrac), n - 1);
    staticSegments.push({
      name: displayNames[si],
      type: seg.type,
      time: (numeric(telemetry[endIdx], "timing.current-lap") ?? 0) - (numeric(telemetry[startIdx], "timing.current-lap") ?? 0),
      ranges: [{ startFrac: seg.startFrac, endFrac: seg.endFrac }],
    });
  }
  const lapWrap = lapWrappedSegmentGroup(segments);
  if (lapWrap) {
    const first = staticSegments[lapWrap.firstIndex];
    const last = staticSegments[lapWrap.lastIndex];
    first.time = Math.max(0, first.time) + Math.max(0, last.time);
    first.ranges = [...last.ranges, ...first.ranges];
    staticSegments.splice(lapWrap.lastIndex, 1);
  }
  return { cumDist, totalDist, staticSegments };
}
function segmentStateSignature({ telemetry, segments, cursorIdx }: SegmentListProps): string | null {
  if (!segments || telemetry.length < 2) return null;
  const firstDistance = numeric(telemetry[0], "timing.distance-traveled");
  const currentDistance = numeric(telemetry[cursorIdx], "timing.distance-traveled");
  const lastDistance = numeric(telemetry[telemetry.length - 1], "timing.distance-traveled");
  if (firstDistance == null || currentDistance == null || lastDistance == null || lastDistance <= firstDistance) return null;
  const cursorFraction = (currentDistance - firstDistance) / (lastDistance - firstDistance);
  let active = -1;
  let completed = 0;
  for (let index = 0; index < segments.length; index++) {
    const segment = segments[index];
    if (cursorFraction >= segment.startFrac && cursorFraction < segment.endFrac) active = index;
    if (cursorFraction >= segment.endFrac) completed++;
  }
  return `${active}:${completed}`;
}

function areSegmentListPropsEqual(previous: SegmentListProps, next: SegmentListProps): boolean {
  if (previous.telemetry !== next.telemetry || previous.segments !== next.segments) return false;
  if (previous.cursorIdx === next.cursorIdx) return true;
  const previousState = segmentStateSignature(previous);
  return previousState != null && previousState === segmentStateSignature(next);
}

export const AnalyseSegmentList = memo(function AnalyseSegmentList({ telemetry, segments, cursorIdx }: SegmentListProps) {
  const segmentData = useMemo(() => (segments ? buildSegmentData(telemetry, segments) : null), [segments, telemetry]);

  // Derive cursor-dependent active/completed state cheaply
  const segmentTimes = useMemo(() => {
    if (!segmentData) return null;
    const cursorDistFrac = segmentData.cumDist[cursorIdx] / segmentData.totalDist;
    return segmentData.staticSegments.map((seg) => ({
      key: `${seg.type}-${seg.name}-${seg.ranges.map((range) => range.startFrac).join("-")}`,
      name: seg.name,
      type: seg.type,
      time: seg.time,
      ranges: seg.ranges,
      active: seg.ranges.some(
        (range) => cursorDistFrac >= range.startFrac && cursorDistFrac < range.endFrac,
      ),
      completed: cursorDistFrac >= Math.min(...seg.ranges.map((range) => range.endFrac)),
    }));
  }, [segmentData, cursorIdx]);

  if (!segmentTimes) {
    return <div className="text-app-caption text-app-text-dim">{m.analyse_no_segment_data()}</div>;
  }

  return (
    <div className="space-y-0.5">
      {segmentTimes.map((seg) => (
        <div key={seg.key} className={`flex items-center justify-between px-1.5 py-1 rounded text-app-compact font-mono ${seg.active ? "bg-app-surface-alt ring-1 ring-inset ring-app-text-dim" : ""}`}>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: seg.type === "corner" ? "var(--track-corner-marker)" : "var(--track-straight-marker)" }} />
            <span className={seg.active ? "text-app-text" : "text-app-text-secondary"}>{seg.name}</span>
          </div>
          <span className={seg.active ? "text-app-text" : "text-app-text-muted"}>{seg.time > 0 ? `${seg.time.toFixed(3)}s` : "-"}</span>
        </div>
      ))}
    </div>
  );
}, areSegmentListPropsEqual);
