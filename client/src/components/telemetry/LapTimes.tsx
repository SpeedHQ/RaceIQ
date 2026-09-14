import { formatLapTime } from "@/lib/format";
import { m } from "@/paraglide/messages";
import type { LiveSectorData } from "../../../../shared/racing/live/types";
import type { LiveTelemetryView } from "../../lib/live-telemetry-view";

interface LapTimesProps {
  view: LiveTelemetryView;
  sectors?: LiveSectorData | null;
}

/**
 * LapTimes — Reusable canonical lap timing display showing current, last, best, and delta.
 */
export function LapTimes({ view, sectors }: LapTimesProps) {
  const { timing } = view;
  const lastLap = timing.lastLapS;
  const bestLap = timing.bestLapS;
  const currentLap = timing.currentLapS;
  const hasLiveProjection = sectors !== null && sectors !== undefined &&
    Number.isFinite(sectors.estimatedLap) && sectors.estimatedLap > 0 &&
    Number.isFinite(sectors.deltaToBest);
  const deltaToBest = hasLiveProjection ? sectors.deltaToBest : undefined;
  const deltaColor = deltaToBest === undefined || deltaToBest <= 0 ? "text-(--delta-gain)" : deltaToBest < 1 ? "text-(--delta-focus)" : "text-(--delta-loss)";

  return (
    <div className="space-y-1">
      <div className="flex gap-3">
        <div className="w-fit">
          <div className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.telemetry_current()}</div>
          <div className="text-3xl font-mono font-bold text-app-text tabular-nums leading-none">{currentLap === undefined ? "--:--.---" : formatLapTime(currentLap)}</div>
        </div>
        <div className="w-fit">
          {hasLiveProjection && <div className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.telemetry_est_lap()}</div>}
          {hasLiveProjection && <div className="text-3xl font-mono font-bold text-app-text tabular-nums leading-none">{formatLapTime(sectors.estimatedLap)}</div>}
        </div>
        <div className="w-fit">
          <div className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.label_delta()}</div>
          <div className={`text-3xl font-mono font-bold tabular-nums leading-none ${deltaToBest === undefined ? "text-app-text-dim" : deltaColor}`}>
            {deltaToBest === undefined ? "--:--.---" : `${deltaToBest <= 0 ? "" : "+"}${deltaToBest.toFixed(3)}`}
          </div>
        </div>
      </div>
      <div className="flex gap-3">
        <div className="w-fit">
          <div className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.telemetry_last()}</div>
          <div className="text-xl font-mono font-bold text-app-text tabular-nums leading-none">{lastLap === undefined ? "--:--.---" : formatLapTime(lastLap)}</div>
        </div>
        <div className="w-fit">
          <div className="text-app-caption text-app-text-muted uppercase tracking-wider">{m.label_best()}</div>
          <div className="text-xl font-mono font-bold text-(--lap-pace-best) tabular-nums leading-none">{bestLap === undefined ? "--:--.---" : formatLapTime(bestLap)}</div>
        </div>
      </div>
    </div>
  );
}
