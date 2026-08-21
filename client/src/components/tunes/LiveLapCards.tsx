import { isTimedLapEligibilityUsable } from "@shared/racing/quality/policies";
import type { LiveSectorData } from "../../../../shared/racing/live/types";
import type { LapMeta } from "../../../../shared/racing/sessions/types";
import { LapStatus } from "@/components/LapStatus";
import { formatLapTime } from "../../lib/format";

interface LiveLapCardsProps {
  laps: LapMeta[];
  trackOrdinal?: number;
  sectors: LiveSectorData | null;
  /** In-progress lap's number (TelemetryPacket.LapNumber), for the leading card's label. */
  currentLapNumber: number | null;
  maxLaps?: number;
}

/**
 * LiveLapCards — card-row replacement for the RecordedLaps table in the live
 * Setup Engineer test dashboard. Leading card is the in-progress lap (running
 * time from WS-pushed LiveSectorData), followed by one card per completed lap
 * (newest first), each showing just the lap number and final time.
 */
export function LiveLapCards({ laps, trackOrdinal, sectors, currentLapNumber, maxLaps = 20 }: LiveLapCardsProps) {
  const filtered = trackOrdinal != null ? laps.filter((l) => l.trackOrdinal === trackOrdinal) : laps;
  const sorted = [...filtered].sort((a, b) => b.lapNumber - a.lapNumber).slice(0, maxLaps);
  const paceLaps = sorted.filter((lap) => isTimedLapEligibilityUsable(lap));
  const best = paceLaps.length ? Math.min(...paceLaps.map((lap) => lap.lapTime)) : 0;
  const running = sectors ? (sectors.estimatedLap > 0 ? sectors.estimatedLap : sectors.currentSectorTime) : 0;

  return (
    <div className="flex gap-2 overflow-x-auto p-2">
      <div className="shrink-0 w-24 rounded border border-app-accent/50 bg-app-accent/10 px-2.5 py-1.5">
        <div className="flex items-center gap-1 text-app-caption uppercase tracking-wider text-app-accent">
          <span className="size-1.5 rounded-full bg-app-accent animate-pulse" />
          Lap {currentLapNumber ?? "—"}
        </div>
        <div className="text-sm font-mono font-bold tabular-nums text-app-text mt-0.5">{running > 0 ? formatLapTime(running) : "--:--.---"}</div>
      </div>
      {sorted.length === 0 ? (
        <div className="flex items-center text-xs text-app-text-dim px-2">No laps completed yet.</div>
      ) : (
        sorted.map((l) => {
          const paceEligible = isTimedLapEligibilityUsable(l);
          const delta = paceEligible && best > 0 ? l.lapTime - best : null;
          const isBest = delta === 0;
          const timeColor = !paceEligible
            ? "text-app-text-muted"
            : isBest
              ? "text-(--lap-pace-best)"
              : delta! < 0.5
                ? "text-(--lap-pace-on-target)"
                : delta! < 1.5
                  ? "text-app-text"
                  : "text-(--lap-pace-off-target)";
          return (
            <div key={l.id} className="shrink-0 w-24 rounded border border-app-border bg-app-surface-alt/40 px-2.5 py-1.5">
              <div className="flex items-center gap-1 text-app-caption uppercase tracking-wider text-app-text-muted">
                <LapStatus lap={l} presentation="indicator" visibility="issues" />
                Lap {l.lapNumber}
              </div>
              <div className={`text-sm font-mono font-bold tabular-nums mt-0.5 ${timeColor}`}>{formatLapTime(l.lapTime)}</div>
            </div>
          );
        })
      )}
    </div>
  );
}
