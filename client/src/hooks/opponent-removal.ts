import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import type { OpponentRemovalPreview, OpponentRemovalRequest, OpponentRemovalStatus } from "@raceiq/shared/racing/sessions/opponent-removal";
import { client } from "@/lib/rpc";
import { errorFromResponse } from "@/lib/rpc-error";
import { queryKeys } from "./query-keys";

const statusKey = ["storage", "session-opponents"] as const;
const affectedKeys = [queryKeys.storageSessions, queryKeys.sessions, queryKeys.laps, queryKeys.cacheStatus,
  ["opponent-lap-catalog"], ["opponent-lap-comparison"], ["lap-semantic-telemetry"], ["aligned-telemetry"], ["opponent-semantic-telemetry"]] as const;

export function useOpponentRemovalStatus() {
  const cache = useQueryClient();
  const query = useQuery({
    queryKey: statusKey,
    queryFn: async (): Promise<OpponentRemovalStatus> => {
      const response = await client.api.storage["session-opponents"].$get();
      if (!response.ok) throw await errorFromResponse(response);
      return response.json();
    },
    refetchInterval: (state) => state.state.data?.status === "running" ? 1000 : false,
    refetchOnMount: "always",
    refetchOnWindowFocus: true,
  });
  const status = query.data?.status;
  const previousStatus = useRef(status);
  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = status;
    if (!status || status === "idle" || status === "running" ||
        (previous !== "running" && !(previous === "partial" && status === "success"))) return;
    for (const key of affectedKeys) {
      void cache.invalidateQueries({ queryKey: key });
    }
  }, [status, cache]);
  return query;
}

export function useStartOpponentRemoval() {
  const cache = useQueryClient();
  return useMutation({
    mutationFn: async (request: OpponentRemovalRequest) => {
      const response = await client.api.storage["session-opponents"].$post({ json: request });
      if (!response.ok) throw await errorFromResponse(response);
      return response.json();
    },
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: statusKey });
      const status = cache.getQueryData<OpponentRemovalStatus>(statusKey)?.status;
      if (status && status !== "idle" && status !== "running") {
        for (const key of affectedKeys) void cache.invalidateQueries({ queryKey: key });
      }
    },
  });
}

export async function previewOpponentRemoval(request: OpponentRemovalRequest): Promise<OpponentRemovalPreview> {
  const response = await client.api.storage["session-opponents"].preview.$post({ json: request });
  if (!response.ok) throw await errorFromResponse(response);
  return response.json();
}
