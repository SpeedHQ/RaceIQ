import { useMemo } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { AlignedLapSet, EncodedAlignedLapSet } from "@shared/racing/laps/alignment/types";
import { decodeAlignedLapSet } from "@shared/racing/laps/alignment/codec";
import { client } from "../lib/rpc";
import { errorFromResponse } from "../lib/rpc-error";

type BaseRequest = { step: 1 };
type DetailRequest = { step: 0.1; start: number; end: number };
export type AlignedTelemetryRequest = BaseRequest | DetailRequest;
type AlignedTelemetryData = AlignedLapSet & { lapIds: number[] };

export function useAlignedTelemetry(lapIds: readonly number[], request: AlignedTelemetryRequest | null): UseQueryResult<AlignedTelemetryData> {
  const ids = useMemo(() => [...lapIds], [lapIds]);
  return useQuery<AlignedTelemetryData>({
    queryKey: ["aligned-telemetry", ids, request],
    enabled: ids.length > 0 && request != null,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: request?.step === 1 ? 30 * 60 * 1000 : 0,
    refetchOnMount: false,
    placeholderData:
      request?.step === 0.1
        ? (previous) => {
            if (!previous || previous.lapIds.length !== ids.length || previous.lapIds.some((id, index) => id !== ids[index])) return undefined;
            return previous;
          }
        : undefined,
    queryFn: async ({ signal }) => {
      if (!request) throw new Error("Aligned telemetry request unavailable");
      const res = await client.api.laps["aligned-telemetry"].$post({ json: { ids, ...request } }, { init: { signal } });
      if (!res.ok) throw await errorFromResponse(res);
      const data = decodeAlignedLapSet((await res.json()) as EncodedAlignedLapSet);
      return { ...data, lapIds: ids };
    },
  });
}
