import { useRaceStrategyHost } from "./host";
import type { LivePitData } from "@raceiq/shared/racing/live/types";

interface PitWindowProps {
  pit: LivePitData | null;
}

/**
 * PitWindow — Pit stop laps remaining + limited by indicator.
 * Pure component; all estimates are already normalized to laps.
 */
export function PitWindow({ pit }: PitWindowProps) {
  const { m } = useRaceStrategyHost();
  const fuelColor =
    pit?.fuelLapsRemaining != null
      ? pit.fuelLapsRemaining < 5
        ? "text-(--severity-critical)"
        : pit.fuelLapsRemaining < 15
          ? "text-(--severity-caution)"
          : "text-(--severity-nominal)"
      : "text-app-text-dim";

  const pitIn = pit?.pitInLaps ?? null;
  const limitedBy = pit?.limitedBy ?? null;
  const urgentColor = pitIn != null ? (pitIn <= 3 ? "text-(--severity-critical)" : pitIn <= 6 ? "text-(--severity-caution)" : "text-(--severity-nominal)") : "text-app-text-muted";

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span className={`text-3xl font-mono font-black tabular-nums leading-none ${urgentColor}`}>{pitIn != null ? `~${pitIn.toFixed(1)}` : "—"}</span>
        <span className="text-xs text-app-text-muted">{m.pitwindow_laps()}</span>
      </div>
      <p className={`mt-1 text-xs ${limitedBy === "fuel" ? fuelColor : "text-app-text-muted"}`}>
        {pit != null && limitedBy ? limitedBy === "fuel" ? m.strategy_limited_fuel() : m.strategy_limited_tires() : m.strategy_no_limiter()}
      </p>
    </div>
  );
}
