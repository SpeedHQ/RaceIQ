import { lapWrappedSegmentGroup, segmentDisplayNames } from "@raceiq/shared/racing/tracks/segment-label";
import { memo, useMemo } from "react";
import { useMessages } from "./host";
import { semanticNumber, type SemanticAnalysisFrame } from "@raceiq/scene-3d/semantic-frame";


interface Segment {
  type: string;
  name: string;
  group?: string;
  number?: number;
  covers?: number[];
  startFrac: number;
  endFrac: number;
}

type SegmentFrame = SemanticAnalysisFrame & { run?: number };

interface SegmentListProps {
  telemetry: SegmentFrame[];
  segments: Segment[] | null;
  cursorIdx: number;
  trackLengthM?: number;
}

export function buildSegmentData(telemetry: SegmentFrame[], segments: Segment[], trackLengthM?: number) {
  if (segments.length === 0 || telemetry.length < 10) return null;
  const n = telemetry.length;
  const cumDist = new Array<number>(n);
  const nativeDistance = typeof trackLengthM === "number" && Number.isFinite(trackLengthM) && trackLengthM > 0;
  cumDist[0] = nativeDistance ? semanticNumber(telemetry[0], "timing.distance-traveled") ?? NaN : 0;

  const firstDistance = semanticNumber(telemetry[0], "timing.distance-traveled");
  const lastDistance = semanticNumber(telemetry[n - 1], "timing.distance-traveled");
  const lapDistance = firstDistance != null && lastDistance != null ? lastDistance - firstDistance : null;
  if (nativeDistance) {
    for (let i = 1; i < n; i++) cumDist[i] = semanticNumber(telemetry[i], "timing.distance-traveled") ?? NaN;
  } else if (lapDistance != null && lapDistance > 0) {
    for (let i = 1; i < n; i++) {
      const distance = semanticNumber(telemetry[i], "timing.distance-traveled");
      const relative = distance != null && firstDistance != null ? distance - firstDistance : null;
      cumDist[i] = relative != null ? Math.max(cumDist[i - 1], relative) : cumDist[i - 1];
    }
  } else {
    for (let i = 1; i < n; i++) {
      const x = semanticNumber(telemetry[i], "motion.position-x");
      const z = semanticNumber(telemetry[i], "motion.position-z");
      const previousX = semanticNumber(telemetry[i - 1], "motion.position-x");
      const previousZ = semanticNumber(telemetry[i - 1], "motion.position-z");
      cumDist[i] = x != null && z != null && previousX != null && previousZ != null ? cumDist[i - 1] + Math.hypot(x - previousX, z - previousZ) : cumDist[i - 1];
    }
  }

  const totalDist = nativeDistance ? trackLengthM : cumDist[n - 1];
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

  function timeAt(distance: number): { time: number; run: number | undefined } | null {
    for (let i = 0; i < n; i++) {
      const currentTime = semanticNumber(telemetry[i], "timing.current-lap");
      if (cumDist[i] === distance && currentTime !== null) return { time: currentTime, run: telemetry[i].run };
      if (i === 0 || !(cumDist[i - 1] < distance && distance < cumDist[i]) || currentTime === null) continue;
      const previousTime = semanticNumber(telemetry[i - 1], "timing.current-lap");
      if (previousTime === null || currentTime < previousTime || telemetry[i - 1].run !== telemetry[i].run) return null;
      return { time: previousTime + (currentTime - previousTime) * (distance - cumDist[i - 1]) / (cumDist[i] - cumDist[i - 1]), run: telemetry[i].run };
    }
    return null;
  }
  function rangeTime(start: number, end: number): number | null {
    if (!nativeDistance) {
      return (semanticNumber(telemetry[fracToIdx(end)], "timing.current-lap") ?? 0)
        - (semanticNumber(telemetry[fracToIdx(start)], "timing.current-lap") ?? 0);
    }
    const from = timeAt(start * totalDist), to = timeAt(end * totalDist);
    return from && to && from.run === to.run && to.time >= from.time ? to.time - from.time : null;
  }

  const displayNames = segmentDisplayNames(segments);
  const lapWrap = lapWrappedSegmentGroup(segments);
  const staticSegments = segments.flatMap((segment, index) => {
    if (lapWrap && (index === lapWrap.firstIndex || index === lapWrap.lastIndex)) {
      if (index === lapWrap.lastIndex) return [];
      const first = segments[lapWrap.firstIndex];
      const last = segments[lapWrap.lastIndex];
      const firstTime = rangeTime(first.startFrac, first.endFrac);
      const lastTime = rangeTime(last.startFrac, last.endFrac);
      return [{
        name: lapWrap.group,
        type: segment.type,
        ranges: [{ startFrac: last.startFrac, endFrac: last.endFrac }, { startFrac: first.startFrac, endFrac: first.endFrac }],
        time: firstTime !== null && lastTime !== null ? firstTime + lastTime : null,
      }];
    }
    const time = rangeTime(segment.startFrac, segment.endFrac);
    return [{
      name: displayNames[index],
      type: segment.type,
      time,
      ranges: [{ startFrac: segment.startFrac, endFrac: segment.endFrac }],
    }];
  });
  return { cumDist, totalDist, staticSegments };
}
function segmentStateSignature({ telemetry, segments, cursorIdx, trackLengthM }: SegmentListProps): string | null {
  if (!segments || telemetry.length < 2) return null;
  const firstDistance = semanticNumber(telemetry[0], "timing.distance-traveled");
  const currentDistance = semanticNumber(telemetry[cursorIdx], "timing.distance-traveled");
  const lastDistance = semanticNumber(telemetry[telemetry.length - 1], "timing.distance-traveled");
  if (firstDistance == null || currentDistance == null || lastDistance == null || lastDistance <= firstDistance) return null;
  const cursorFraction = trackLengthM ? currentDistance / trackLengthM : (currentDistance - firstDistance) / (lastDistance - firstDistance);
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
  if (previous.telemetry !== next.telemetry || previous.segments !== next.segments || previous.trackLengthM !== next.trackLengthM) return false;
  if (previous.cursorIdx === next.cursorIdx) return true;
  const previousState = segmentStateSignature(previous);
  return previousState != null && previousState === segmentStateSignature(next);
}

export const AnalyseSegmentList = memo(function AnalyseSegmentList({ telemetry, segments, cursorIdx, trackLengthM }: SegmentListProps) {
  const m = useMessages();
  const segmentData = useMemo(() => (segments ? buildSegmentData(telemetry, segments, trackLengthM) : null), [segments, telemetry, trackLengthM]);

  // Derive cursor-dependent active/completed state cheaply
  const segmentTimes = useMemo(() => {
    if (!segmentData) return null;
    const cursorDistFrac = segmentData.cumDist[cursorIdx] / segmentData.totalDist;
    return segmentData.staticSegments.map((seg) => ({
      key: `${seg.type}-${seg.name}-${seg.ranges.map((range) => range.startFrac).join("-")}`,
      name: seg.name,
      type: seg.type,
      time: seg.time,
      active: seg.ranges.some((range) => cursorDistFrac >= range.startFrac && cursorDistFrac < range.endFrac),
      completed: seg.ranges.every((range) => cursorDistFrac >= range.endFrac),
    }));
  }, [segmentData, cursorIdx]);

  if (!segmentTimes) {
    return <div className="text-app-caption text-app-text-dim">{m.analyse_no_segment_data()}</div>;
  }

  return (
    <div className="space-y-0.5">
      {segmentTimes.map((seg) => (
        <div key={seg.key} aria-current={seg.active ? "true" : undefined} className={`flex items-center justify-between px-1.5 py-1 rounded text-app-compact font-mono ${seg.active ? "bg-app-surface-alt ring-1 ring-inset ring-app-text-dim" : ""}`}>
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: seg.type === "corner" ? "var(--track-corner-marker)" : "var(--track-straight-marker)" }} />
            <span className={seg.active ? "text-app-text" : "text-app-text-secondary"}>{seg.name}</span>
          </div>
          <span className={seg.active ? "text-app-text" : "text-app-text-muted"}>{seg.time !== null && seg.time > 0 ? `${seg.time.toFixed(3)}s` : "-"}</span>
        </div>
      ))}
    </div>
  );
}, areSegmentListPropsEqual);
