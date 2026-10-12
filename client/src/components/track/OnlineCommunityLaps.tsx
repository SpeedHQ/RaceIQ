import { useEffect, useState } from "react";
import { m } from "@/paraglide/messages";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { LeaderboardInput, OnlineErrorCode } from "@raceiq/shared/integrations/raceiq-online";
import { useOnlineLeaderboard, useRaceIqOnline } from "@/hooks/raceiq-online";
import { onlineErrorMessage } from "@/components/online/messages";
import { OnlineTransportFailure } from "@/lib/raceiq-online";
import { getLocale } from "@/paraglide/runtime";

const errorMessage = (code: OnlineErrorCode) => {
  switch (code) {
    case "unsupported_game": return m.online_community_laps_unknown_game();
    case "unknown_track": return m.online_community_laps_unknown_track();
    case "unknown_car": return m.online_community_laps_unknown_car();
    case "offline": return m.online_community_laps_offline();
    case "not_connected": return m.online_error_not_connected();
    case "consent_required": return m.online_error_consent_required();
    default: return onlineErrorMessage(code);
  }
};

export function OnlineCommunityLaps({ gameId, trackId, carId }: { gameId: string | null; trackId: string | null; carId: string | null }) {
  const online = useRaceIqOnline();
  const input: LeaderboardInput | null = gameId && trackId && carId ? { gameId, trackId, carId } : null;
  const query = useOnlineLeaderboard(input);
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
  const stateNotice = online.state?.connection.status === "signed_out"
    ? m.online_community_laps_not_connected()
    : online.state?.consent.status === "required" || online.state?.consent.status === "not_accepted"
      ? m.online_community_laps_consent_required()
      : online.state?.preferences?.visibility === "private"
        ? m.online_community_laps_private()
        : null;
  if (!input) return <div className="p-4 text-sm text-app-text-dim">{m.online_community_laps_select_car()}</div>;
  const board = query.data;
  const error = board?.error;
  const transportFailure = query.error instanceof OnlineTransportFailure ? query.error : online.transportError;
  const retryAllowed = error?.retryable ?? transportFailure?.retryable ?? false;
  const retryAt = retryAfter ? Date.parse(retryAfter) : 0;
  const canRetry = retryAllowed && retryDelayElapsed && (!retryAt || Date.now() >= retryAt);
  const staleRows = board?.rows.length ? board.rows : [];
  const errorText = error ? errorMessage(error.code) : transportFailure ? m.online_transport_error() : null;

  return (
    <section aria-label={m.online_community_laps_title()} aria-live="polite" className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <h2 className="px-3 pt-3 text-app-detail font-semibold text-app-text">{m.online_onboarding_title()}</h2>
      {stateNotice && <p className="px-3 pt-3 text-sm text-app-text-dim">{stateNotice}</p>}
      {online.state?.service === "offline" && <p className="px-3 pt-3 text-sm text-app-text-dim">{m.online_community_laps_offline()}</p>}
      {online.state?.service === "unavailable" && <p className="px-3 pt-3 text-sm text-app-text-dim">{m.online_community_laps_unavailable()}</p>}
      {online.accountHidden && <p role="status" className="p-4 text-sm text-app-text-dim">{online.signOutPending ? m.online_signout_pending() : m.online_signout_unknown()}</p>}
      {query.isPending && !board && !online.accountHidden && !transportFailure && <p className="p-4 text-sm text-app-text-dim">{m.online_community_laps_loading()}</p>}
      {errorText && <div role="alert" className="flex flex-wrap items-center gap-2 p-3 text-sm text-app-text-dim">
        <span>{errorText}</span>
        {canRetry && <Button type="button" variant="outline" size="sm" onClick={() => void query.refetch()}>{m.online_community_laps_retry()}</Button>}
      </div>}
      {board?.stale && staleRows.length > 0 && board.fetchedAt && <p className="px-3 pb-2 text-xs text-app-text-muted">{m.online_community_laps_stale({ timestamp: new Date(board.fetchedAt).toLocaleString(getLocale()) })}</p>}
      {board?.status === "unavailable" && staleRows.length === 0 && !errorText && <p className="p-4 text-sm text-app-text-dim">{m.online_community_laps_unavailable()}</p>}
      {board?.status === "empty" && <p className="p-4 text-sm text-app-text-dim">{m.online_community_laps_empty()}</p>}
      {staleRows.length > 0 && <div className="min-h-0 flex-1 overflow-auto">
        <Table className="w-full text-app-detail [&_thead]:sticky [&_thead]:top-0 [&_thead]:z-10 [&_thead]:bg-app-surface [&_thead>tr]:border-b [&_thead>tr]:border-app-border [&_thead>tr]:text-app-label [&_thead>tr]:uppercase [&_thead>tr]:tracking-wider [&_thead>tr]:text-app-text-muted [&_tbody]:divide-y [&_tbody]:divide-app-border/40">
          <TableHeader><TableRow><TableHead>{m.online_community_laps_rank()}</TableHead><TableHead>{m.online_community_laps_driver()}</TableHead><TableHead className="text-right">{m.online_community_laps_time()}</TableHead></TableRow></TableHeader>
          <TableBody>{staleRows.map((row) => <TableRow key={row.lapId}>
            <TableCell className="px-3 py-2 font-mono tabular-nums">{row.rank}</TableCell>
            <TableCell className="max-w-64 whitespace-normal break-words px-3 py-2 font-semibold text-app-text">{row.driver.displayName}</TableCell>
            <TableCell className="px-3 py-2 text-right font-mono tabular-nums text-app-accent">{formatMilliseconds(row.lapTimeMs)}</TableCell>
          </TableRow>)}</TableBody>
        </Table>
      </div>}
    </section>
  );
}

function formatMilliseconds(value: number): string {
  const minutes = Math.floor(value / 60_000);
  const seconds = (value % 60_000) / 1_000;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}
