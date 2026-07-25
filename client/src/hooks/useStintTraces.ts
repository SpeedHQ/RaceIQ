import type { LapMeta } from "@shared/types";
import { type EncodedLapTrace, decodeLapTrace, type LapTrace } from "@shared/stint-trace";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { client } from "../lib/rpc";

export interface UseStintTracesResult {
  /** Downsampled traces, in the same order as the input laps (undefined for
   *  any lap the server had no trace for). */
  traces: (LapTrace | undefined)[];
  /** How many laps have settled. */
  loadedCount: number;
  total: number;
  isLoading: boolean;
}

/**
 * Fetches every lap's downsampled trace in a SINGLE batch request. The server
 * decodes each session's laps in one pass and returns ~14-channel LapTraces as
 * base64 Float32 columns (see /api/laps/traces) — far cheaper than the old path
 * of fetching full telemetry per lap and reducing it client-side (50 laps ×
 * ~80 fields over the wire). Traces are cached with staleTime Infinity so a
 * re-mount with the same lap set resolves instantly.
 */
export function useStintTraces(laps: LapMeta[]): UseStintTracesResult {
  const ids = useMemo(() => laps.map((l) => l.id), [laps]);
  const idsKey = ids.join(",");

  const query = useQuery({
    queryKey: ["stint-traces", idsKey],
    enabled: ids.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 1000 * 60 * 30,
    queryFn: async (): Promise<Map<number, LapTrace>> => {
      const res = await client.api.laps.traces.$post({ json: { ids } });
      if (!res.ok) throw new Error(res.statusText);
      const data = (await res.json()) as { traces: EncodedLapTrace[] };
      const byId = new Map<number, LapTrace>();
      for (const enc of data.traces) byId.set(enc.lapId, decodeLapTrace(enc));
      return byId;
    },
  });

  const byId = query.data;
  const traces = useMemo(() => (byId ? laps.map((l) => byId.get(l.id)) : laps.map(() => undefined)), [byId, laps]);

  const settled = query.isSuccess || query.isError;
  return {
    traces,
    loadedCount: settled ? laps.length : 0,
    total: laps.length,
    isLoading: ids.length > 0 && !settled,
  };
}
