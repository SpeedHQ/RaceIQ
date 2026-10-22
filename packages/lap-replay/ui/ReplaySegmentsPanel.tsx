import { useMemo, useSyncExternalStore } from "react";
import type { SpectateController, SpectateLap, SpectateSegment } from "../contracts/spectate";
import { AnalyseSegmentList } from "./AnalyseSegmentList";

export function ReplaySegmentsPanel({ lap, controller, segments }: {
  lap: SpectateLap;
  controller: SpectateController;
  segments: readonly SpectateSegment[];
}) {
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const telemetry = useMemo(() => lap.samples.map((sample) => ({
    values: {
      ...sample.values,
      "timing.distance-traveled": Number.isFinite(sample.distance) ? sample.distance : null,
      "timing.current-lap": sample.time,
    },
    states: {},
    freshness: {},
  })), [lap]);
  const segmentList = useMemo(() => Array.from(segments), [segments]);
  let low = 0, high = lap.samples.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (lap.samples[middle]!.time <= snapshot.time) low = middle + 1;
    else high = middle;
  }
  return <div className="h-full overflow-y-auto p-3">
    <AnalyseSegmentList telemetry={telemetry} segments={segmentList} cursorIdx={Math.max(0, low - 1)} />
  </div>;
}
