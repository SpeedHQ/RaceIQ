import type { SessionDownsampleRequest, SessionDownsampleStatus } from "@raceiq/shared/racing/sessions/downsample";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { client } from "@/lib/rpc";
import { queryKeys } from "./query-keys";

async function readStatus(): Promise<SessionDownsampleStatus> {
  const response = await client.api.storage["session-downsample"].$get();
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json() as Promise<SessionDownsampleStatus>;
}

export function useSessionDownsampleStatus() {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: queryKeys.sessionDownsampleStatus,
    queryFn: readStatus,
    refetchInterval: (current) => (current.state.data?.status === "running" ? 1000 : false),
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
  });
  useEffect(() => {
    if (query.data && query.data.status !== "running" && query.data.status !== "idle") {
      void Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.storageSessions }),
        queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
        queryClient.invalidateQueries({ queryKey: queryKeys.laps }),
        queryClient.invalidateQueries({ queryKey: ["lap-semantic-telemetry"] }),
        queryClient.invalidateQueries({ queryKey: ["aligned-telemetry"] }),
        queryClient.invalidateQueries({ queryKey: queryKeys.cacheStatus }),
        queryClient.invalidateQueries({ queryKey: queryKeys.userTunes }),
      ]);
    }
  }, [query.dataUpdatedAt, query.data?.status, queryClient]);
  return query;
}

export function useStartSessionDownsample() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: SessionDownsampleRequest) => {
      const response = await client.api.storage["session-downsample"].$post({ json: request });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
      }
      return response.json() as Promise<{ accepted: true }>;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sessionDownsampleStatus }),
  });
}

export async function previewSessionDownsample(request: SessionDownsampleRequest) {
  const response = await client.api.storage["session-downsample"].preview.$post({ json: request });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${response.status} ${response.statusText}`);
  }
  return response.json();
}
