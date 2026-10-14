import type { DashboardRecentSession } from "@raceiq/shared/racing/sessions/dashboard";
import { Card } from "@/components/ui/card";
import { EmptyStateOverlay } from "@/components/ui/empty-state-overlay";
import { Skeleton } from "@/components/ui/skeleton";
import { formatLapTime } from "@/components/LiveTelemetry";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { parseUtcTimestamp } from "@/lib/utc-date";
import { SessionTypeBadge } from "@/components/sessions/SessionTypeBadge";

function formatTimeAgo(date: Date): string {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return m.home_just_now();
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${m.home_minutes_ago()}`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${m.home_hours_ago()}`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ${m.home_days_ago()}`;
  return date.toLocaleDateString(getLocale());
}

export function RecentSessionsTable({
  sessions,
  gameId,
  onAnalyseSession,
  loading = false,
  error = false,
}: {
  sessions: DashboardRecentSession[];
  gameId: string | null;
  onAnalyseSession: (session: DashboardRecentSession) => void;
  loading?: boolean;
  error?: boolean;
}) {
  const stateMessage = error ? m.common_error() : loading ? m.common_loading() : sessions.length === 0 ? m.home_no_sessions() : null;
  const placeholderRows = stateMessage ? Array.from({ length: 8 }, (_, index) => index) : [];
  return (
    <Card className="relative flex h-[440px] min-h-0 flex-col gap-2 overflow-hidden p-3" aria-busy={loading}>
      <h2 className="shrink-0 text-app-heading font-semibold text-app-text/90">{m.home_recent_sessions()}</h2>
      <div className="relative min-h-0 flex-1 overflow-auto">
    <Table containerClassName="rounded-none border-0">
      <TableHeader>
        <TableRow>
          {!gameId && <TableHead className="bg-transparent">{m.home_col_game()}</TableHead>}
          <TableHead className="bg-transparent">{m.label_track()}</TableHead>
          <TableHead className="bg-transparent">{m.label_car()}</TableHead>
          <TableHead className="bg-transparent">{m.label_type()}</TableHead>
          <TableHead className="bg-transparent">{m.label_laps()}</TableHead>
          <TableHead className="bg-transparent">{m.sessions_col_best_lap()}</TableHead>
          <TableHead className="bg-transparent text-right">{m.home_col_when()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {stateMessage ? placeholderRows.map((row) => <TableRow key={row} aria-hidden="true">{Array.from({ length: gameId ? 6 : 7 }, (_, column) => <TableCell key={column} className="text-app-text-muted">{row === 0 && column === 0 ? <span className="sr-only" role={error ? "alert" : loading ? "status" : undefined}>{stateMessage}</span> : <Skeleton loading={loading}>—</Skeleton>}</TableCell>)}</TableRow>) : sessions.map((session) => {
          const track = session.track.name ?? "—";
          const car = session.car.name ?? "—";
          return (
            <TableRow key={session.id} className="cursor-pointer" onClick={() => onAnalyseSession(session)}>
              {!gameId && (
                <TableCell>
                  <Badge variant="game-brand" size="compact" data-game-brand={session.gameId}>
                    {session.gameId === "f1-2025" ? "F1" : session.gameId === "acc" ? "ACC" : session.gameId === "ac-evo" ? "ACE" : session.gameId === "iracing" ? "iR" : session.gameId === "lmu" ? "LMU" : "FM"}
                  </Badge>
                </TableCell>
              )}
              <TableCell className="text-app-text" title={track}>
                <button
                  type="button"
                  className="cursor-pointer text-left focus-visible:outline-2 focus-visible:outline-app-text"
                  aria-label={`${m.sessions_analyse_session()}: ${track || "—"}, ${parseUtcTimestamp(session.createdAt).toLocaleDateString(getLocale())}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onAnalyseSession(session);
                  }}
                >
                  {track || "—"}
                </button>
              </TableCell>
              <TableCell className="text-app-text" title={car}>{car || "—"}</TableCell>
              <TableCell className="text-app-text"><SessionTypeBadge type={session.sessionType} /></TableCell>
              <TableCell className="text-right tabular-nums text-app-text">{session.lapCount ?? 0}</TableCell>
              <TableCell className="text-right tabular-nums font-medium text-app-text">{session.bestLapSeconds != null ? formatLapTime(session.bestLapSeconds) : "—"}</TableCell>
              <TableCell className="text-right tabular-nums text-app-text">{formatTimeAgo(parseUtcTimestamp(session.createdAt))}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
      </Table>
      {!loading && !error && sessions.length === 0 && <EmptyStateOverlay />}
      </div>
    </Card>
  );
}
