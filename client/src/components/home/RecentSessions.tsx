import { getLMUCar, getLMUTrack } from "@shared/games/lmu/catalog";
import type { SessionMeta } from "@shared/racing/sessions/types";
import { formatLapTime } from "@/components/LiveTelemetry";
import { Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
import { Badge } from "@/components/ui/badge";
import { m } from "@/paraglide/messages";
import { getLocale } from "@/paraglide/runtime";

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
      <THead>
        {!gameId && <TH>{m.home_col_game()}</TH>}
        <TH>{m.label_track()}</TH>
        <TH>{m.label_car()}</TH>
        <TH>{m.label_laps()}</TH>
        <TH>{m.sessions_col_best_lap()}</TH>
        <TH align="end">{m.home_col_when()}</TH>
      </THead>
      <TBody>
        {sessions.map((session) => {
          const track = session.gameId === "lmu" && typeof session.trackId === "string"
            ? getLMUTrack(session.trackId)?.name ?? session.trackId
            : trackNames[`${session.gameId}:${session.trackOrdinal}`] ?? "";
          const car = session.gameId === "lmu" && typeof session.carId === "string"
            ? getLMUCar(session.carId)?.name ?? session.carId
            : carNames[`${session.gameId}:${session.carOrdinal}`] ?? "";
          return (
            <TRow key={session.id} onClick={() => onAnalyseSession(session)}>
              {!gameId && (
                <TD>
                  <Badge variant="game-brand" size="compact" data-game-brand={session.gameId ?? "fm-2023"}>
                    {session.gameId === "f1-2025" ? "F1" : session.gameId === "acc" ? "ACC" : session.gameId === "ac-evo" ? "ACE" : session.gameId === "iracing" ? "iR" : session.gameId === "lmu" ? "LMU" : "FM"}
                  </Badge>
                </TD>
              )}
              <TD tone="primary" truncate="narrow" title={track}>
                <button
                  type="button"
                  className="text-left focus-visible:outline-2 focus-visible:outline-app-text"
                  aria-label={`${m.sessions_analyse_session()}: ${track || "—"}, ${new Date(session.createdAt).toLocaleDateString(getLocale())}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    onAnalyseSession(session);
                  }}
                >
                  {track || "—"}
                </button>
              </TD>
              <TD tone="primary" truncate="narrow" title={car}>{car || "—"}</TD>
              <TD numeric tone="primary">{session.lapCount ?? 0}</TD>
              <TD emphasis numeric nowrap tone="primary">{session.bestLapTime ? formatLapTime(session.bestLapTime) : "—"}</TD>
              <TD align="end" nowrap tone="primary">{formatTimeAgo(new Date(session.createdAt))}</TD>
            </TRow>
          );
        })}
      </TBody>
    </Table>
  );
}
