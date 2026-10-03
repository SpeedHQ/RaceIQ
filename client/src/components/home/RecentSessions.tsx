import { getLMUCar, getLMUTrack } from "@raceiq/shared/games/lmu/catalog";
import type { SessionMeta } from "@raceiq/shared/racing/sessions/types";
import { formatLapTime } from "@/components/LiveTelemetry";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";
import { parseUtcTimestamp } from "@/lib/utc-date";

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
  carNames,
  trackNames,
  gameId,
  onAnalyseSession,
  loading = false,
  error = false,
}: {
  sessions: SessionMeta[];
  carNames: Record<string, string>;
  trackNames: Record<string, string>;
  gameId: string | null;
  onAnalyseSession: (session: SessionMeta) => void;
  loading?: boolean;
  error?: boolean;
}) {
  if (loading) {
    return (
      <div role="status" className="p-6 text-center text-app-text/90">
        {m.common_loading()}
      </div>
    );
  }
  if (error) {
    return (
      <div role="alert" className="p-6 text-center text-status-danger">
        {m.common_error()}
      </div>
    );
  }
  if (sessions.length === 0) {
    return <div className="p-6 text-center text-app-text/90">{m.home_no_sessions()}</div>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {!gameId && <TableHead>{m.home_col_game()}</TableHead>}
          <TableHead>{m.label_track()}</TableHead>
          <TableHead>{m.label_car()}</TableHead>
          <TableHead>{m.label_laps()}</TableHead>
          <TableHead>{m.sessions_col_best_lap()}</TableHead>
          <TableHead className="text-right">{m.home_col_when()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sessions.map((session) => {
          const track = session.gameId === "lmu" && typeof session.trackId === "string"
            ? getLMUTrack(session.trackId)?.name ?? session.trackId
            : trackNames[`${session.gameId}:${session.trackOrdinal}`] ?? "";
          const car = session.gameId === "lmu" && typeof session.carId === "string"
            ? getLMUCar(session.carId)?.name ?? session.carId
            : carNames[`${session.gameId}:${session.carOrdinal}`] ?? "";
          return (
            <TableRow key={session.id} className="cursor-pointer" onClick={() => onAnalyseSession(session)}>
              {!gameId && (
                <TableCell>
                  <Badge variant="game-brand" size="compact" data-game-brand={session.gameId ?? "fm-2023"}>
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
              <TableCell className="text-right tabular-nums text-app-text">{session.lapCount ?? 0}</TableCell>
              <TableCell className="text-right tabular-nums font-medium text-app-text">{session.bestLapTime ? formatLapTime(session.bestLapTime) : "—"}</TableCell>
              <TableCell className="text-right tabular-nums text-app-text">{formatTimeAgo(parseUtcTimestamp(session.createdAt))}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
