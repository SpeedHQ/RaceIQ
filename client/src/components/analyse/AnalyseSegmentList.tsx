import { useMemo, memo } from "react";
import type { TelemetryPacket } from "@shared/types";

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

export const AnalyseSegmentList = memo(function AnalyseSegmentList({
  telemetry,
  segments,
  cursorIdx,
}: SegmentListProps) {
  // Precompute static segment data (expensive) — cumDist, times, names
  const segmentData = useMemo(() => {
    if (!segments || segments.length === 0 || telemetry.length < 10) return null;
    const n = telemetry.length;
    const cumDist = [0];
    for (let i = 1; i < n; i++) {
      const p = telemetry[i], pp = telemetry[i - 1];
      const dx = p.PositionX - pp.PositionX;
      const dz = p.PositionZ - pp.PositionZ;
      cumDist.push(cumDist[i - 1] + Math.sqrt(dx * dx + dz * dz));
    }
    const totalDist = cumDist[n - 1] || 1;
    function fracToIdx(frac: number): number {
      const targetDist = frac * totalDist;
      let lo = 0, hi = n - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumDist[mid] < targetDist) lo = mid + 1; else hi = mid;
      }
      return lo;
    }
    let sNum = 1;
    const displayNames = segments.map((s) => {
      if (s.type === "straight" && (!s.name || /^S[\d?]*$/.test(s.name))) return `S${sNum++}`;
      if (s.type === "straight") sNum++;
      return s.name;
    });
    const staticSegments: { name: string; type: string; time: number; startFrac: number; endFrac: number }[] = [];
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      const startIdx = fracToIdx(seg.startFrac);
      const endIdx = Math.min(fracToIdx(seg.endFrac), n - 1);
      staticSegments.push({ name: displayNames[si], type: seg.type, time: (telemetry[endIdx]?.CurrentLap ?? 0) - (telemetry[startIdx]?.CurrentLap ?? 0), startFrac: seg.startFrac, endFrac: seg.endFrac });
    }
    return { cumDist, totalDist, staticSegments };
  }, [segments, telemetry]);

  // Derive cursor-dependent active/completed state cheaply
  const segmentTimes = useMemo(() => {
    if (!segmentData) return null;
    const cursorDistFrac = segmentData.cumDist[cursorIdx] / segmentData.totalDist;
    return segmentData.staticSegments.map((seg) => ({
      name: seg.name,
      type: seg.type,
      time: seg.time,
      active: cursorDistFrac >= seg.startFrac && cursorDistFrac < seg.endFrac,
      completed: cursorDistFrac >= seg.endFrac,
    }));
  }, [segmentData, cursorIdx]);

  if (!segmentTimes) {
    return <div className="text-[10px] text-app-text-dim">No segment data</div>;
  }

  return (
    <div className="space-y-0.5">
      {segmentTimes.map((seg, i) => (
        <div
          key={i}
          className={`flex items-center justify-between px-1.5 py-1 rounded text-[11px] font-mono ${
            seg.active ? "bg-app-surface-alt ring-1 ring-inset ring-app-text-dim" : ""
          }`}
        >
          <div className="flex items-center gap-1.5">
            <div
              className="w-1.5 h-1.5 rounded-full"
              style={{ backgroundColor: seg.type === "corner" ? "#f59e0b" : "#3b82f6" }}
            />
            <span className={seg.active ? "text-app-text" : "text-app-text-secondary"}>{seg.name}</span>
          </div>
          <span className={seg.active ? "text-app-text" : "text-app-text-muted"}>
            {seg.time > 0 ? seg.time.toFixed(3) + "s" : "-"}
          </span>
        </div>
      ))}
    </div>
  );
});
