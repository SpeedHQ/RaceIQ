import type { LapMeta } from "@shared/racing/sessions/types";
import { formatLapTime } from "@/components/LiveTelemetry";
import { LapStatus } from "@/components/LapStatus";
import { Table, TBody, TD, TH, THead, TRow } from "@/components/ui/AppTable";
import { Badge } from "@/components/ui/badge";
import { m } from "@/paraglide/messages";

function formatTimeAgo(date: Date): string {
  const sec = Math.floor((Date.now() - date.getTime()) / 1000);
  if (sec < 60) return m.home_just_now();
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${m.home_minutes_ago()}`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ${m.home_hours_ago()}`;
  if (sec < 604800) return `${Math.floor(sec / 86400)}d ${m.home_days_ago()}`;
  return date.toLocaleDateString();
}

export function RecentLapsTable({
  laps,
  carNames,
  trackNames,
  gameId,
  onAnalyseLap,
  loading = false,
  error = false,
}: {
  laps: LapMeta[];
  carNames: Record<string, string>;
  trackNames: Record<string, string>;
  gameId: string | null;
  onAnalyseLap: (lap: LapMeta) => void;
  loading?: boolean;
  error?: boolean;
}) {
  const showGame = !gameId;
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
  if (laps.length === 0) {
    return <div className="p-6 text-center text-app-text/90">{m.home_no_laps()}</div>;
  }

  return (
    <Table>
      <THead>
        {showGame && <TH>{m.home_col_game()}</TH>}
        <TH>{m.label_track()}</TH>
        <TH>{m.label_car()}</TH>
        <TH>{m.label_lap()}</TH>
        <TH>{m.label_time()}</TH>
        <TH align="end">{m.home_col_when()}</TH>
      </THead>
      <TBody>
        {laps.map((lap) => {
          const track = lap.trackOrdinal != null ? (trackNames[`${lap.gameId}:${lap.trackOrdinal}`] ?? "") : "";
          const car = lap.carOrdinal != null ? (carNames[`${lap.gameId}:${lap.carOrdinal}`] ?? "") : "";
          const ago = formatTimeAgo(new Date(lap.createdAt));
          return (
            <TRow
              key={lap.id}
              onClick={() => {
                onAnalyseLap(lap);
              }}
            >
              {showGame && (
                <TD>
                  <Badge variant="game-brand" size="compact" data-game-brand={lap.gameId ?? "fm-2023"}>
                    {lap.gameId === "f1-2025" ? "F1" : lap.gameId === "acc" ? "ACC" : lap.gameId === "ac-evo" ? "ACE" : lap.gameId === "iracing" ? "iR" : "FM"}
                  </Badge>
                </TD>
              )}
              <TD tone="primary" truncate="narrow" title={track}>
                {track || "—"}
              </TD>
              <TD tone="primary" truncate="narrow" title={car}>
                {car || "—"}
              </TD>
              <TD numeric tone="primary">
                {lap.lapNumber}
              </TD>
              <TD emphasis numeric nowrap tone="primary">
                <span className="flex items-center gap-1">
                  {formatLapTime(lap.lapTime)}
                  <LapStatus lap={lap} presentation="indicator" />
                </span>
              </TD>
              <TD align="end" nowrap tone="primary">
                {ago}
              </TD>
            </TRow>
          );
        })}
      </TBody>
    </Table>
  );
}
