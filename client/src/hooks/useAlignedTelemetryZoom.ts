import { useCallback, useEffect, useMemo, useState } from "react";
import type { AlignedLapSet } from "@shared/racing/laps/alignment/types";
import { cropAlignedLapSet, mergeAlignedLapRange, normalizeFidelityRange, shouldLoadHighFidelity } from "../lib/aligned-telemetry-fidelity";
import { useAlignedTelemetry } from "./aligned-telemetry";

export function useAlignedTelemetryZoom(lapIds: readonly number[], base: AlignedLapSet | undefined) {
  const [stack, setStack] = useState<Array<{ start: number; end: number } | null>>([null]);
  const [detail, setDetail] = useState<{ start: number; end: number } | null>(null);
  const [optimistic, setOptimistic] = useState<AlignedLapSet | null>(null);
  const current = stack.at(-1);
  const request = detail ? { step: 0.1 as const, start: detail.start, end: detail.end } : { step: 1 as const };
  const query = useAlignedTelemetry(lapIds, request);
  useEffect(() => { setStack([null]); setDetail(null); setOptimistic(null); }, [lapIds.join(",")]);
  useEffect(() => { if (query.data && detail) { setOptimistic(null); setDetail(null); } }, [query.data, detail]);
  const visible = useMemo(() => {
    if (!base) return undefined;
    if (!current) return base;
    if (optimistic) return optimistic;
    if (query.data) return mergeAlignedLapRange(base, query.data);
    return cropAlignedLapSet(base, current.start, current.end);
  }, [base, current, optimistic, query.data]);
  const selectRangeMeters = useCallback((start: number, end: number) => {
    if (!base) return;
    const domain = current ? current.end - current.start : base.nominalSpanMeters;
    const origin = current?.start ?? 0;
    const selected = Math.abs(end - start);
    if (!shouldLoadHighFidelity(selected, domain)) { setStack((levels) => [...levels, null]); setDetail(null); setOptimistic(null); return; }
    const range = normalizeFidelityRange(origin + Math.min(start, end), origin + Math.max(start, end), base.nominalSpanMeters);
    setStack((levels) => [...levels, range]);
    setOptimistic(cropAlignedLapSet(base, range.start, range.end));
    setDetail(range);
  }, [base, current]);
  const zoomOut = useCallback(() => { setStack((levels) => levels.length > 1 ? levels.slice(0, -1) : levels); setDetail(null); setOptimistic(null); }, []);
  return { data: visible, visibleRange: current, isFetching: query.isFetching, error: query.error, selectRangeMeters, zoomOut };
}
