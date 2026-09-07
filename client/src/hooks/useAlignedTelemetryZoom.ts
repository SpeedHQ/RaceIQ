import { useCallback, useEffect, useMemo, useState } from "react";
import type { AlignedLapSet } from "@shared/racing/laps/alignment/types";
import { cropAlignedLapSet, mergeAlignedLapRange, normalizeFidelityRange, shouldLoadHighFidelity } from "../lib/aligned-telemetry-fidelity";
import { useAlignedTelemetry } from "./aligned-telemetry";

export function useAlignedTelemetryZoom(lapIds: readonly number[], base: AlignedLapSet | undefined) {
  const [stack, setStack] = useState<Array<{ start: number; end: number } | null>>([null]);
  const [detail, setDetail] = useState<{ start: number; end: number } | null>(null);
  const [resolvedDetail, setResolvedDetail] = useState<AlignedLapSet | null>(null);
  const [optimistic, setOptimistic] = useState<AlignedLapSet | null>(null);
  const current = stack.at(-1);
  const request = useMemo(
    () => (detail ? { step: 0.1 as const, start: detail.start, end: detail.end } : { step: 1 as const }),
    [detail],
  );
  const query = useAlignedTelemetry(lapIds, request);
  useEffect(() => {
    setStack([null]);
    setDetail(null);
    setResolvedDetail(null);
    setOptimistic(null);
  }, [lapIds.join(",")]);
  useEffect(() => {
    if (query.data && detail) {
      setResolvedDetail(query.data);
      setOptimistic(null);
    }
  }, [query.data, detail]);
  const visible = useMemo(() => {
    if (!base) return undefined;
    if (!current) return base;
    if (resolvedDetail) return mergeAlignedLapRange(base, resolvedDetail);
    if (optimistic) return optimistic;
    return cropAlignedLapSet(base, current.start, current.end);
  }, [base, current, optimistic, resolvedDetail]);
  const selectRangeMeters = useCallback((start: number, end: number) => {
    if (!base) return;
    const domain = current ? current.end - current.start : base.nominalSpanMeters;
    const selected = Math.abs(end - start);
    if (!shouldLoadHighFidelity(selected, domain)) {
      setStack((levels) => [...levels, null]);
      setDetail(null);
      setResolvedDetail(null);
      setOptimistic(null);
      return;
    }
    const range = normalizeFidelityRange(Math.min(start, end), Math.max(start, end), base.nominalSpanMeters);
    setStack((levels) => [...levels, range]);
    setResolvedDetail(null);
    setOptimistic(cropAlignedLapSet(base, range.start, range.end));
    setDetail(range);
  }, [base, current]);
  const zoomOut = useCallback(() => {
    setStack((levels) => levels.length > 1 ? levels.slice(0, -1) : levels);
    setDetail(null);
    setResolvedDetail(null);
    setOptimistic(null);
  }, []);
  return { data: visible, visibleRange: current, isFetching: query.isFetching, error: query.error, selectRangeMeters, zoomOut };
}
