import type { LapMeta, TelemetryPacket } from "@shared/types";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { client } from "../lib/rpc";
import { downsampleLap, type LapTrace, TRACE_SAMPLES } from "../lib/stint-traces";

interface LapTelemetryResponse {
  telemetry: TelemetryPacket[];
  isLegacy: boolean;
  sectorTimes: { times: [number, number, number]; s1Idx: number; s2Idx: number; firstDist: number; lapDist: number } | null;
}

export interface UseStintTracesResult {
  /** Downsampled traces, in the same order as the input laps (legacy laps
   *  omitted). Undefined entries mean "not fetched yet" (sequential loading
   *  hasn't reached them, or the fetch is still in flight). */
  traces: (LapTrace | undefined)[];
  /** How many laps have settled (fetched + downsampled, or errored/empty). */
  loadedCount: number;
  total: number;
  isLoading: boolean;
}

/**
 * Fetches each lap's full telemetry SEQUENTIALLY (concurrency 1) and
 * immediately reduces it to a small downsampled trace — never holding more
 * than one lap's raw telemetry (5-50 MB) in memory at a time. Only the
 * downsampled trace (~8 KB) is cached, so unlike `useLapTelemetry` it's safe
 * to keep around for the whole stint (staleTime Infinity, gcTime 30min).
 *
 * Sequencing is driven by a small piece of local state (`unlocked`) rather
 * than each query reading its sibling's live status directly — the array of
 * query results doesn't exist until after this same `useQueries` call
 * returns, so gating `enabled` on "the previous query settled" needs a value
 * that survives across renders. `unlocked` starts at 1 (lap 0 always
 * enabled) and advances by one every time the query at `unlocked - 1`
 * settles, admitting the next lap on the following render.
 */
export function useStintTraces(laps: LapMeta[], n: number = TRACE_SAMPLES): UseStintTracesResult {
  const eligible = useMemo(() => laps.filter((l) => !l.isLegacy), [laps]);
  const idsKey = eligible.map((l) => l.id).join(",");
  const [unlocked, setUnlocked] = useState(1);

  // Reset sequencing whenever the lap set itself changes (new stint, laps
  // added/removed) so a shorter list doesn't get stuck waiting on an index
  // that no longer exists.
  useEffect(() => {
    setUnlocked(1);
  }, [idsKey]);

  const results = useQueries({
    queries: eligible.map((lap, i) => ({
      queryKey: ["lap-trace", lap.id, n],
      queryFn: async (): Promise<LapTrace | null> => {
        const res = await client.api.laps[":id"].$get({ param: { id: String(lap.id) } });
        if (!res.ok) throw new Error(res.statusText);
        const data = (await res.json()) as LapTelemetryResponse;
        if (data.isLegacy) return null;
        return downsampleLap(lap.id, lap.lapNumber, lap.isValid, data.telemetry, data.sectorTimes, n);
      },
      enabled: i < unlocked,
      staleTime: Number.POSITIVE_INFINITY,
      gcTime: 1000 * 60 * 30,
    })),
  });

  // Advance the unlock cursor once the current frontier query settles
  // (success, error, or already-cached). Also fast-forward past any laps
  // whose trace is already cached (staleTime Infinity means a re-mount with
  // the same lap set resolves instantly instead of re-serializing one lap
  // at a time).
  useEffect(() => {
    let next = unlocked;
    while (next < results.length && (results[next - 1]?.isSuccess || results[next - 1]?.isError)) {
      next++;
    }
    if (next !== unlocked) setUnlocked(next);
  }, [results, unlocked]);

  const traces = results.map((r) => r.data ?? undefined);
  const loadedCount = results.filter((r) => r.isSuccess || r.isError).length;
  const isLoading = loadedCount < results.length;

  return { traces, loadedCount, total: results.length, isLoading };
}
