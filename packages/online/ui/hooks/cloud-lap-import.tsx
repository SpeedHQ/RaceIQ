import { useEffect, useRef, useState } from "react";
import { CancelledError, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CloudLapImportState } from "@raceiq/shared/integrations/cloud-lap-import";
import type { LeaderboardInput, OnlineMutationContext } from "@raceiq/online/contracts";
import type { OnlineMessages, OnlineUiHost } from "../../contracts/ui-host";
import { onlineErrorMessage } from "../messages";
import { useOnlineHost, useRaceIqOnline } from "./raceiq-online";

export const cloudImportKey = ["cloud-lap-import"] as const;
// A Community click must not activate after its selection or entitlement has changed.
// Native/website requests still use the backend's independent entitlement/context check.
let communityIntent: { lapId: string; lapGuid: string; current: () => boolean } | null = null;

export function useCloudLapImport() {
  const host = useOnlineHost();
  const online = useRaceIqOnline();
  const query = useQuery<CloudLapImportState>({
    queryKey: [...cloudImportKey, online.state?.accountEpoch, online.state?.revision, online.communityGeneration],
    queryFn: async ({ signal }) => {
      if (!online.state || !online.communityAllowed || !online.isCurrentCommunityContext()) throw new CancelledError({ silent: true });
      const state = await host.getCloudLapImport({ accountEpoch: online.state.accountEpoch, expectedRevision: online.state.revision }, signal);
      if (signal.aborted || !online.isCurrentCommunityContext()) throw new CancelledError({ silent: true });
      if (state.status !== "idle" && (state.access?.accountEpoch !== online.state.accountEpoch || state.access?.expectedRevision !== online.state.revision)) throw new CancelledError({ silent: true });
      return state;
    },
    enabled: online.communityAllowed,
    refetchInterval: 1_000,
    refetchIntervalInBackground: false,
    retry: false,
  });
  return { ...query, data: online.communityAllowed && !query.isError ? query.data : undefined };
}

export async function startCloudLapImport(host: OnlineUiHost, input: LeaderboardInput & OnlineMutationContext & { lapId: string; lapGuid: string }, current: () => boolean): Promise<void> {
  if (!current()) return;
  communityIntent = { lapId: input.lapId, lapGuid: input.lapGuid, current };
  const response = await host.startCloudLapImport(input);
  await requireCloudImportResponse(response, host.m);
}

export async function retryCloudLapImport(host: OnlineUiHost, state: CloudLapImportState, context: OnlineMutationContext, current: () => boolean): Promise<void> {
  if (state.activationId == null || !current() || state.access?.accountEpoch !== context.accountEpoch || state.access?.expectedRevision !== context.expectedRevision || (communityIntent?.lapId === state.lapId && !communityIntent.current())) return;
  const response = await host.retryCloudLapImport({ ...context, activationId: state.activationId });
  await requireCloudImportResponse(response, host.m);
}

function cloudImportCodeMessage(code: string | undefined, m: OnlineMessages): string {
  switch (code) {
    case "recording_unavailable": return m.online_community_laps_import_unavailable();
    case "lap_owner_conflict": case "lap_identity_conflict": case "activity_owner_conflict":
    case "driver_identity_required": case "mixed_driver_lap": case "activity_identity_ambiguous":
    case "activity_revision_conflict": case "sharing_required": case "consent_required": case "stale_state":
    case "unsupported_recording_format": case "recording_too_large": case "recording_not_ready":
    case "not_connected": case "service_unavailable": case "offline":
      return onlineErrorMessage(code, m);
    default: return m.online_community_laps_import_error();
  }
}

export class CloudLapImportRequestFailure extends Error {
  constructor(m: OnlineMessages, code?: string) { super(cloudImportCodeMessage(code, m)); }
}

export async function requireCloudImportResponse(response: Pick<Response, "ok" | "json">, m: OnlineMessages): Promise<void> {
  if (response.ok) return;
  let code: string | undefined;
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null && "code" in body.error && typeof body.error.code === "string") code = body.error.code;
  } catch { /* Malformed responses never expose raw backend text. */ }
  throw new CloudLapImportRequestFailure(m, code);
}

export function cloudImportRequestErrorMessage(error: unknown, m: OnlineMessages): string {
  return error instanceof CloudLapImportRequestFailure ? error.message : m.online_community_laps_import_error();
}

export function cloudImportStatusMessage(state: CloudLapImportState, m: OnlineMessages): string {
  switch (state.status) {
    case "awaiting_sign_in": return m.online_loading();
    case "downloading": return m.online_community_laps_import_downloading();
    case "validating": return m.online_community_laps_import_validating();
    case "registering": return m.online_community_laps_import_registering();
    case "complete": return m.online_community_laps_import_complete();
    case "error": return cloudImportCodeMessage(state.error?.code, m);
    default: return "";
  }
}

/** Mounted once; independently opened local replays never depend on this remote action gate. */
export function CloudLapImportActivation() {
  const host = useOnlineHost();
  const { m, Button } = host;
  const online = useRaceIqOnline();
  const stateQuery = useCloudLapImport();
  const queryClient = useQueryClient();
  const navigate = host.useNavigateToReplay();
  const activated = useRef<string | null>(null);
  const [activationError, setActivationError] = useState<{ key: string; message: string } | null>(null);
  const state = stateQuery.data;
  const lap = state?.localLap;
  useEffect(() => {
    if (!online.state || !online.communityAllowed || !online.isCurrentCommunityContext() || state?.status !== "complete" || state.activationId == null || !lap?.id || !lap.gameId || !lap.sessionId || !state.lapGuid || lap.gameId !== state.selection?.gameId || state.access?.accountEpoch !== online.state.accountEpoch || state.access?.expectedRevision !== online.state.revision) return;
    const intent = communityIntent?.lapId === state.lapId ? communityIntent : null;
    if (intent && (intent.lapGuid !== state.lapGuid || !intent.current())) return;
    const activationId = state.activationId;
    const access = { accountEpoch: online.state.accountEpoch, expectedRevision: online.state.revision };
    const activationKey = `${access.accountEpoch}:${activationId}`;
    if (activated.current === activationKey) return;
    const prefix = host.routePrefixForGameId(lap.gameId);
    if (!prefix) return;
    let disposed = false;
    let acknowledged = false;
    void (async () => {
      try {
        // Let a superseded/StrictMode effect dispose before issuing its acknowledgement.
        await Promise.resolve();
        if (disposed || !online.isCurrentCommunityContext() || (intent && (communityIntent !== intent || !intent.current())) || activated.current === activationKey) return;
        activated.current = activationKey;
        // Backend acknowledgement rechecks entitlement before any cached replay navigation.
        const acknowledgement = await host.acknowledgeCloudLapImport({ activationId, ...access });
        await requireCloudImportResponse(acknowledgement, m);
        acknowledged = true;
        if (disposed || !online.isCurrentCommunityContext() || (intent && (communityIntent !== intent || !intent.current()))) return;
        host.invalidateCaptureQueries(queryClient);
        await navigate({ gameId: lap.gameId, sessionId: lap.sessionId, id: lap.id });
        await queryClient.invalidateQueries({ queryKey: cloudImportKey });
      } catch (error) {
        if (!disposed) {
          if (!acknowledged) activated.current = null;
          setActivationError({ key: activationKey, message: cloudImportRequestErrorMessage(error, m) });
        }
      }
    })();
    return () => { disposed = true; };
  }, [state?.status, state?.activationId, state?.lapId, state?.lapGuid, state?.access?.accountEpoch, state?.access?.expectedRevision, state?.selection?.gameId, state?.selection?.trackId, state?.selection?.carId, lap?.id, lap?.gameId, lap?.sessionId, online.state?.accountEpoch, online.state?.revision, online.communityAllowed, online.communityGeneration, navigate, queryClient]);
  const failed = state?.status === "error";
  const activationFailure = activationError?.key === `${state?.access?.accountEpoch}:${state?.activationId}` ? activationError.message : null;
  if (!online.communityAllowed) return null;
  if (stateQuery.isError) return <div role="alert" className="fixed bottom-3 right-3 z-50 max-w-sm rounded-md border border-app-border bg-app-surface p-3 text-app-detail text-app-text">{cloudImportRequestErrorMessage(stateQuery.error, m)}</div>;
  if (!state || state.status === "idle" || state.status === "complete" && !activationFailure) return null;
  return <div className="fixed bottom-3 right-3 z-50 max-w-sm rounded-md border border-app-border bg-app-surface p-3 text-app-detail text-app-text">
    {activationFailure && <p role="alert">{activationFailure}</p>}
    <div role={failed ? "alert" : "status"} className="flex flex-wrap items-center gap-2">
      <span>{cloudImportStatusMessage(state, m)}</span>
      {failed && state.error?.retryable && state.activationId != null && online.state && <Button size="sm" variant="outline" onClick={() => { if (online.state) void retryCloudLapImport(host, state, { accountEpoch: online.state.accountEpoch, expectedRevision: online.state.revision }, online.isCurrentCommunityContext).catch(() => void stateQuery.refetch()); }}>{m.online_community_laps_retry()}</Button>}
      {failed && state.error?.code === "recording_unavailable" && <Button size="sm" variant="outline" onClick={() => void queryClient.invalidateQueries({ queryKey: ["raceiq-online", "leaderboard"] })}>{m.online_community_laps_refresh()}</Button>}
    </div>
  </div>;
}
