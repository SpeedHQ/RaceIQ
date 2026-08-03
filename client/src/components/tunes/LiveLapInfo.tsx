import type { LiveSectorData } from "../../../../shared/racing/live/types";
import { formatLapTime } from "../../lib/format";
import { SectorTimes } from "../SectorTimes";

/** Delta chip — green when ahead of reference, red when behind. */
function Delta({ value }: { value: number }) {
  if (!value) return null;
  const ahead = value < 0;
  return (
    <span className={`text-xs font-mono font-bold ${ahead ? "text-(--delta-gain)" : "text-(--delta-loss)"}`}>
      {ahead ? "" : "+"}
      {value.toFixed(3)}
    </span>
  );
}

/**
 * LiveLapInfo — display-only lap header shown right of the car vitals panel in
 * LiveTestDashboard: lap count, running lap time + delta to best, last/best lap,
 * and the server-computed sector splits. All values come from the WS-pushed
 * LiveSectorData / current packet — no client-side timing computation here.
 */
export function LiveLapInfo({ sectors, currentLap, totalLaps }: { sectors: LiveSectorData | null; currentLap: number | null; totalLaps: number }) {
  const running = sectors ? (sectors.estimatedLap > 0 ? sectors.estimatedLap : sectors.currentSectorTime) : 0;
  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-app-caption uppercase tracking-wider text-app-text-muted">Current Lap</div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-mono font-bold tabular-nums text-app-text">{running > 0 ? formatLapTime(running) : "--:--.---"}</span>
            {sectors && <Delta value={sectors.deltaToBest} />}
          </div>
        </div>
        <div className="text-right">
          <div className="text-app-caption uppercase tracking-wider text-app-text-muted">Lap</div>
          <div className="text-2xl font-mono font-bold tabular-nums text-app-accent">
            {currentLap ?? "—"}
            {totalLaps > 0 && <span className="text-sm text-app-text-muted"> / {totalLaps}</span>}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="rounded bg-app-surface-alt/40 px-2.5 py-1.5">
          <div className="text-app-caption text-app-text-muted">Last</div>
          <div className="text-sm font-mono font-bold tabular-nums text-app-text-secondary">{sectors && sectors.lastLapTime > 0 ? formatLapTime(sectors.lastLapTime) : "-"}</div>
        </div>
        <div className="rounded bg-app-surface-alt/40 px-2.5 py-1.5">
          <div className="text-app-caption text-(--lap-pace-best)">Best</div>
          <div className="text-sm font-mono font-bold tabular-nums text-(--lap-pace-best)">{sectors && sectors.bestLapTime > 0 ? formatLapTime(sectors.bestLapTime) : "-"}</div>
        </div>
      </div>

      <SectorTimes sectors={sectors} />
    </div>
  );
}
