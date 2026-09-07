import { useQuery } from "@tanstack/react-query";
import type { EncodedAlignedLapSet } from "@shared/racing/laps/alignment/types";
import { decodeAlignedLapSet } from "@shared/racing/laps/alignment/codec";
import { client } from "../lib/rpc";
import { errorFromResponse } from "../lib/rpc-error";

type BaseRequest = { step: 1 };
type DetailRequest = { step: 0.1; start: number; end: number };
export type AlignedTelemetryRequest = BaseRequest | DetailRequest;
export function useAlignedTelemetry(lapIds: readonly number[], request: AlignedTelemetryRequest) {
  const ids = [...lapIds];
  return useQuery({
    queryKey: ["aligned-telemetry", ids, request],
    enabled: ids.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
    queryFn: async ({ signal }) => {
      const res = await client.api.laps["aligned-telemetry"].$post({ json: { ids, ...request } }, { init: { signal } });
      if (!res.ok) throw await errorFromResponse(res);
      return decodeAlignedLapSet(await res.json() as EncodedAlignedLapSet);
    },
  });
}
