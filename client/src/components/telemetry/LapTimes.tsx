import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";
import type { LiveSectorData } from "../../../../shared/racing/live/types";
import type { LiveTelemetryView } from "../../lib/live-telemetry-view";

interface LapTimesProps {
  view?: LiveTelemetryView;
  sectors?: LiveSectorData | null;
}

/**
 * LapTimes — Reusable lap timing display showing current, last, best, and delta.
 * Works with any game - uses semantic live telemetry data.
 */
export function LapTimes({ view, sectors }: LapTimesProps) {
  const timing = view?.timing;
  let deltaToBest = sectors?.deltaToBest ?? 0;
  const lastLap = timing?.lastLapS ?? 0;
  const bestLap = timing?.bestLapS ?? 0;
  const currentLap = timing?.currentLapS ?? 0;
  if (lastLap > 0 && bestLap > 0 && deltaToBest === 0) {
    deltaToBest = lastLap - bestLap;
  }

  const deltaColor = deltaToBest <= 0 ? "text-(--delta-gain)" : deltaToBest < 1 ? "text-(--delta-focus)" : "text-(--delta-loss)";

  return (
    <div className="space-y-1">
      <div className="flex gap-3">
        <div className="w-fit">
          <div className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.telemetry_current()}</div>
          <div className="text-3xl font-mono font-bold text-app-text tabular-nums leading-none">{formatLapTime(currentLap)}</div>
        </div>
        <div className="w-fit">
          <div className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.telemetry_est_lap()}</div>
          <div className="text-3xl font-mono font-bold text-app-text tabular-nums leading-none">{formatLapTime(sectors?.estimatedLap ?? 0)}</div>
        </div>
        <div className="w-fit">
          <div className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.label_delta()}</div>
          <div className={`text-3xl font-mono font-bold tabular-nums leading-none ${deltaToBest === 0 ? "text-app-text-dim" : deltaColor}`}>
            {deltaToBest === 0 ? "--:--.---" : `${deltaToBest <= 0 ? "" : "+"}${deltaToBest.toFixed(3)}`}
          </div>
        </div>
      </div>
      <div className="flex gap-3">
        <div className="w-fit">
          <div className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.telemetry_last()}</div>
          <div className="text-xl font-mono font-bold text-app-text tabular-nums leading-none">{formatLapTime(lastLap)}</div>
        </div>
        <div className="w-fit">
          <div className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.label_best()}</div>
          <div className="text-xl font-mono font-bold text-(--lap-pace-best) tabular-nums leading-none">{formatLapTime(bestLap)}</div>
        </div>
      </div>
    </div>
  );
}
