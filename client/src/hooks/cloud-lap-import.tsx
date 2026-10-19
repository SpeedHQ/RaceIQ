import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import type { CloudLapImportState } from "@raceiq/shared/integrations/cloud-lap-import";
import { client } from "@/lib/rpc";
import { m } from "@/paraglide/messages";
import { routePrefixForGameId } from "@/lib/game-routes";
import { queryKeys } from "@/hooks/query-keys";
import { Button } from "@/components/ui/button";
import { useRaceIqOnline } from "@/hooks/raceiq-online";

export const cloudImportKey = ["cloud-lap-import"] as const;

export function useCloudLapImport() {
  return useQuery<CloudLapImportState>({
    queryKey: cloudImportKey,
    queryFn: async () => {
      const response = await client.api.online["lap-import"].$get();
      if (!response.ok) throw new Error("Cloud lap import state unavailable");
      return await response.json() as CloudLapImportState;
    },
    refetchInterval: 1_000,
    refetchIntervalInBackground: true,
    retry: false,
  });
}

export async function startCloudLapImport(lapId: string): Promise<void> {
  const response = await client.api.online["lap-import"].$post({ json: { lapId } });
  if (!response.ok) throw new Error("Cloud lap import failed");
}

export async function retryCloudLapImport(): Promise<void> {
  const response = await client.api.online["lap-import"].retry.$post({ json: {} });
  if (!response.ok) throw new Error("Cloud lap import retry failed");
}

export function cloudImportStatusMessage(state: CloudLapImportState): string {
  switch (state.status) {
    case "awaiting_sign_in": return m.online_community_laps_import_sign_in();
    case "downloading": return m.online_community_laps_import_downloading();
    case "validating": return m.online_community_laps_import_validating();
    case "registering": return m.online_community_laps_import_registering();
    case "complete": return m.online_community_laps_import_complete();
    case "error": return state.error?.code === "recording_unavailable" ? m.online_community_laps_import_unavailable() : m.online_community_laps_import_error();
    default: return "";
  }
}

/** Mounted once at the app root so background/native imports complete from any route. */
export function CloudLapImportActivation() {
  const stateQuery = useCloudLapImport();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const activated = useRef<number | null>(null);
  const state = stateQuery.data;
  const lap = state?.localLap;
  useEffect(() => {
    if (state?.status !== "complete" || state.activationId == null || !lap?.id || !lap.gameId || !lap.sessionId) return;
    const activationId = state.activationId;
    if (activated.current === activationId) return;
    const prefix = routePrefixForGameId(lap.gameId);
    if (!prefix) return;
    activated.current = activationId;
    void (async () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.laps });
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
      try {
        await navigate({ to: `/${prefix}/sessions/${lap.sessionId}/replay/${lap.id}` as never });
        const acknowledgement = await client.api.online["lap-import"].ack.$post({ json: { activationId } });
        if (!acknowledgement.ok && acknowledgement.status !== 409) throw new Error("Cloud lap import acknowledgement failed");
        await queryClient.invalidateQueries({ queryKey: cloudImportKey });
      } catch {
        activated.current = null;
        await stateQuery.refetch();
      }
    })();
  }, [state?.status, state?.activationId, lap?.id, lap?.gameId, lap?.sessionId, navigate, queryClient, stateQuery]);
  const online = useRaceIqOnline();
  const failed = state?.status === "error";
  if (!stateQuery.isError && (!state || state.status === "idle" || state.status === "complete")) return null;
  return <div className="fixed bottom-3 right-3 z-50 max-w-sm rounded-md border border-app-border bg-app-surface p-3 text-app-detail text-app-text">
    {stateQuery.isError && <div role="alert" className="flex items-center gap-2"><span>{m.online_transport_error()}</span><Button size="sm" variant="outline" onClick={() => void stateQuery.refetch()}>{m.online_community_laps_retry()}</Button></div>}
    {!stateQuery.isError && state && state.status !== "idle" && <div role={failed ? "alert" : "status"} className="flex flex-wrap items-center gap-2">
      <span>{cloudImportStatusMessage(state)}</span>
      {state.status === "awaiting_sign_in" && <Button size="sm" variant="outline" onClick={() => void online.connect()}>{m.online_community_laps_sign_in_resume()}</Button>}
      {failed && state.error?.retryable && <Button size="sm" variant="outline" onClick={() => { void retryCloudLapImport().catch(() => void stateQuery.refetch()); }}>{m.online_community_laps_retry()}</Button>}
      {failed && state.error?.code === "auth_required" && <Button size="sm" variant="outline" onClick={() => void online.connect()}>{m.online_community_laps_sign_in_resume()}</Button>}
      {failed && state.error?.code === "recording_unavailable" && <Button size="sm" variant="outline" onClick={() => void queryClient.invalidateQueries({ queryKey: ["raceiq-online", "leaderboard"] })}>{m.online_community_laps_refresh()}</Button>}
      {failed && state.error && !state.error.retryable && state.error.code !== "auth_required" && state.error.code !== "recording_unavailable" && <span>{m.online_community_laps_import_invalid()}</span>}
    </div>}
  </div>;
}
