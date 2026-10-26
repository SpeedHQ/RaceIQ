import { useEffect, useRef, useState } from "react";
import type { OnlineMessages } from "../../contracts/ui-host";
import type { LeaderboardInput, OnlineErrorCode } from "@raceiq/online/contracts";
import { useOnlineHost, useOnlineLeaderboard, useRaceIqOnline } from "../hooks/raceiq-online";
import { onlineErrorMessage } from "../messages";
import { OnlineTransportFailure } from "../lib/raceiq-online";
import { useCloudLapImport, startCloudLapImport, retryCloudLapImport, cloudImportStatusMessage, cloudImportRequestErrorMessage } from "../hooks/cloud-lap-import";
const errorMessage = (code: OnlineErrorCode, m: OnlineMessages) => {
  switch (code) {
    case "unsupported_game": return m.online_community_laps_unknown_game();
    case "unknown_track": return m.online_community_laps_unknown_track();
    case "unknown_car": return m.online_community_laps_unknown_car();
    case "offline": return m.online_community_laps_offline();
    case "consent_required": return m.online_error_consent_required();
    case "sharing_required": return m.online_community_laps_private();
    default: return onlineErrorMessage(code, m);
  }
};

export function OnlineCommunityLaps({ gameId, trackId, carId }: { gameId: string | null; trackId: string | null; carId: string | null }) {
  const host = useOnlineHost();
  const { m, Button, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, getLocale } = host;
  const online = useRaceIqOnline();
  const input: LeaderboardInput | null = gameId && trackId && carId ? { gameId, trackId, carId } : null;
  const selectionKey = `${gameId}:${trackId}:${carId}`;
  const selection = useRef<string | null>(selectionKey);
  selection.current = selectionKey;
  useEffect(() => { selection.current = selectionKey; return () => { selection.current = null; }; }, []);
  useEffect(() => { setOpenError(null); }, [selectionKey, online.state?.accountEpoch, online.communityGeneration]);
  const query = useOnlineLeaderboard(input);
  const importQuery = useCloudLapImport();
  const importingLap = ["awaiting_sign_in", "downloading", "validating", "registering"].includes(importQuery.data?.status ?? "");
  const [openError, setOpenError] = useState<string | null>(null);
  const retryAfter = query.data?.error?.retryAfter;
  const [retryDelayElapsed, setRetryDelayElapsed] = useState(true);
  useEffect(() => {
    if (!retryAfter) { setRetryDelayElapsed(true); return; }
    const delay = Date.parse(retryAfter) - Date.now();
    if (delay <= 0) { setRetryDelayElapsed(true); return; }
    setRetryDelayElapsed(false);
    const timer = window.setTimeout(() => setRetryDelayElapsed(true), Math.min(delay, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [retryAfter]);
  const state = online.state;
  const locked = !query.accessAllowed;
  const stateNotice = state?.connection.status !== "connected"
    ? m.online_community_laps_not_connected()
    : state.consent.status !== "accepted" || state.policy.status !== "available" || state.consent.versions.termsVersion !== state.policy.versions.termsVersion || state.consent.versions.privacyVersion !== state.policy.versions.privacyVersion
      ? m.online_community_laps_consent_required()
      : state.preferences?.visibility !== "public" || state.preferencePersistence !== "confirmed"
        ? m.online_community_laps_private()
        : online.isCachedState || online.transportError || state.service !== "available" ? m.online_community_laps_unavailable() : null;
  if (!input) return <div className="p-4 text-sm text-app-text-dim">{m.online_community_laps_select_car()}</div>;
  if (locked) return <section aria-label={m.online_community_laps_title()} className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <h2 className="px-3 pt-3 text-app-detail font-semibold text-app-text">{m.online_community_laps_title()}</h2>
    <p role="status" className="p-4 text-sm text-app-text-dim">{stateNotice ?? m.online_community_laps_private()}</p>
  </section>;
  const board = query.data;
  const error = board?.error;
  const transportFailure = query.error instanceof OnlineTransportFailure ? query.error : online.transportError;
  const retryAllowed = error?.retryable ?? transportFailure?.retryable ?? false;
  const retryAt = retryAfter ? Date.parse(retryAfter) : 0;
  const canRetry = retryAllowed && retryDelayElapsed && (!retryAt || Date.now() >= retryAt);
  const staleRows = board?.status === "ready" && !board.stale && !error && !query.isError ? board.rows : [];
  const errorText = error ? errorMessage(error.code, m) : transportFailure ? m.online_transport_error() : null;
  const importState = importQuery.data?.selection?.gameId === gameId && importQuery.data?.selection?.trackId === trackId && importQuery.data?.selection?.carId === carId ? importQuery.data : undefined;
  return <section aria-label={m.online_community_laps_title()} aria-live="polite" className="flex min-h-0 flex-1 flex-col overflow-hidden">
    <h2 className="px-3 pt-3 text-app-detail font-semibold text-app-text">{m.online_community_laps_title()}</h2>
    <p className="px-3 pt-2 text-xs text-app-text-muted">{m.online_community_best_effort()}</p>
    {online.state?.service === "offline" && <p className="px-3 pt-3 text-sm text-app-text-dim">{m.online_community_laps_offline()}</p>}
    {online.state?.service === "unavailable" && <p className="px-3 pt-3 text-sm text-app-text-dim">{m.online_community_laps_unavailable()}</p>}
    {online.accountHidden && <p role="status" className="p-4 text-sm text-app-text-dim">{online.signOutPending ? m.online_signout_pending() : m.online_signout_unknown()}</p>}
    {query.isPending && !board && !online.accountHidden && !transportFailure && <p className="p-4 text-sm text-app-text-dim">{m.online_community_laps_loading()}</p>}
    {errorText && <div role="alert" className="flex flex-wrap items-center gap-2 p-3 text-sm text-app-text-dim"><span>{errorText}</span>{canRetry && <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>{m.online_community_laps_retry()}</Button>}</div>}
    {importState && importState.status !== "idle" && <div role={importState.status === "error" ? "alert" : "status"} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm text-app-text-dim">
      <span>{cloudImportStatusMessage(importState, m)}</span>
      {importState.status === "error" && importState.error?.retryable && importState.activationId != null && state && <Button type="button" variant="outline" size="sm" onClick={() => { void retryCloudLapImport(host, importState, { accountEpoch: state.accountEpoch, expectedRevision: state.revision }, () => selection.current === selectionKey && online.isCurrentCommunityContext()).catch((error) => { if (selection.current === selectionKey && online.isCurrentCommunityContext()) setOpenError(cloudImportRequestErrorMessage(error, m)); }); }}>{m.online_community_laps_retry()}</Button>}
      {importState.status === "error" && importState.error?.code === "recording_unavailable" && <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>{m.online_community_laps_refresh()}</Button>}
    </div>}
    {openError && <p role="alert" className="px-3 py-2 text-sm text-status-danger">{openError}</p>}
    {board?.stale && board.fetchedAt && <p className="px-3 pb-2 text-xs text-app-text-muted">{m.online_community_laps_stale({ timestamp: new Date(board.fetchedAt).toLocaleString(getLocale()) })}</p>}
    {(board?.status === "unavailable" || board?.status === "empty") && staleRows.length === 0 && <div className="flex items-center gap-2 p-4 text-sm text-app-text-dim"><span>{board.status === "empty" ? m.online_community_laps_empty() : m.online_community_laps_unavailable()}</span>{board.status === "unavailable" && <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>{m.online_community_laps_retry()}</Button>}</div>}
    {staleRows.length > 0 && <div className="min-h-0 flex-1 overflow-auto"><Table className="w-full text-app-detail [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-app-surface [&_thead>tr]:border-b [&_thead>tr]:border-app-border [&_thead>tr]:text-app-label [&_thead>tr]:uppercase [&_thead>tr]:tracking-wider [&_thead>tr]:text-app-text-muted [&_tbody]:divide-y [&_tbody]:divide-app-border/40">
      <TableHeader><TableRow><TableHead>{m.online_community_laps_rank()}</TableHead><TableHead>{m.online_community_laps_driver()}</TableHead><TableHead className="text-right">{m.online_community_laps_time()}</TableHead><TableHead className="text-right">{m.online_community_laps_action()}</TableHead></TableRow></TableHeader>
      <TableBody>{staleRows.map((row) => <TableRow key={row.lapGuid}><TableCell className="px-3 py-2 font-mono tabular-nums">{row.rank}</TableCell><TableCell className="max-w-64 whitespace-normal break-words px-3 py-2 font-semibold text-app-text">{row.driver.displayName}<span className="mt-1 block break-all text-xs font-normal text-app-text-muted">{row.lapGuid}</span></TableCell><TableCell className="px-3 py-2 text-right font-mono tabular-nums text-app-accent">{formatMilliseconds(row.lapTimeMs)}</TableCell><TableCell className="px-3 py-2 text-right">{row.importAvailable && state ? <Button type="button" variant="outline" size="sm" disabled={importingLap} onClick={() => { setOpenError(null); void startCloudLapImport(host, { ...input, accountEpoch: state.accountEpoch, expectedRevision: state.revision, lapId: row.lapId, lapGuid: row.lapGuid }, () => selection.current === selectionKey && online.isCurrentCommunityContext()).then(() => importQuery.refetch()).catch((error) => { if (selection.current === selectionKey && online.isCurrentCommunityContext()) { setOpenError(cloudImportRequestErrorMessage(error, m)); void query.refetch(); } }); }}>{m.online_community_laps_open_lap()}</Button> : <span className="text-app-text-muted">{m.online_community_recording_unavailable()}</span>}</TableCell></TableRow>)}</TableBody>
    </Table></div>}
  </section>;
}
function formatMilliseconds(value: number): string {
  const minutes = Math.floor(value / 60_000);
  const seconds = (value % 60_000) / 1_000;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}
