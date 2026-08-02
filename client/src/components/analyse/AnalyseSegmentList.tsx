import type { TelemetryPacket } from "@shared/types";
import { memo, useMemo } from "react";
import { m } from "@/paraglide/messages";

interface Segment {
  type: string;
  name: string;
  startFrac: number;
  endFrac: number;
}

interface SegmentListProps {
  telemetry: TelemetryPacket[];
  segments: Segment[] | null;
  cursorIdx: number;
}

export function buildSegmentData(telemetry: TelemetryPacket[], segments: Segment[]) {
  if (segments.length === 0 || telemetry.length < 10) return null;
  const n = telemetry.length;
  const cumDist = new Array<number>(n);
  cumDist[0] = 0;

  const firstDistance = telemetry[0].DistanceTraveled;
  const lapDistance = telemetry[n - 1].DistanceTraveled - firstDistance;
  if (Number.isFinite(lapDistance) && lapDistance > 0) {
    for (let i = 1; i < n; i++) {
      const distance = telemetry[i].DistanceTraveled - firstDistance;
      cumDist[i] = Number.isFinite(distance) ? Math.max(cumDist[i - 1], distance) : cumDist[i - 1];
    }
  } else {
    for (let i = 1; i < n; i++) {
      const p = telemetry[i];
      const previous = telemetry[i - 1];
      const dx = p.PositionX - previous.PositionX;
      const dz = p.PositionZ - previous.PositionZ;
      cumDist[i] = cumDist[i - 1] + Math.hypot(dx, dz);
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

  let straightNumber = 1;
  const displayNames = segments.map((segment) => {
    if (segment.type === "straight" && (!segment.name || /^S[\d?]*$/.test(segment.name))) return `S${straightNumber++}`;
    if (segment.type === "straight") straightNumber++;
    return segment.name;
  });
  const staticSegments = segments.map((segment, index) => {
    const startIdx = fracToIdx(segment.startFrac);
    const endIdx = Math.min(fracToIdx(segment.endFrac), n - 1);
    return {
      name: displayNames[index],
      type: segment.type,
      time: (telemetry[endIdx]?.CurrentLap ?? 0) - (telemetry[startIdx]?.CurrentLap ?? 0),
      startFrac: segment.startFrac,
      endFrac: segment.endFrac,
    };
  });
  return { cumDist, totalDist, staticSegments };
}

export const AnalyseSegmentList = memo(function AnalyseSegmentList({ telemetry, segments, cursorIdx }: SegmentListProps) {
  const segmentData = useMemo(() => (segments ? buildSegmentData(telemetry, segments) : null), [segments, telemetry]);

  // Derive cursor-dependent active/completed state cheaply
  const segmentTimes = useMemo(() => {
    if (!segmentData) return null;
    const cursorDistFrac = segmentData.cumDist[cursorIdx] / segmentData.totalDist;
    return segmentData.staticSegments.map((seg) => ({
      key: `${seg.type}-${seg.name}-${seg.startFrac}-${seg.endFrac}`,
      name: seg.name,
      type: seg.type,
      time: seg.time,
      active: cursorDistFrac >= seg.startFrac && cursorDistFrac < seg.endFrac,
      completed: cursorDistFrac >= seg.endFrac,
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
});
