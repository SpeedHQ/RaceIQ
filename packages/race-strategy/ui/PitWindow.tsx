import type { GameId } from "@raceiq/shared/games/ids";
import { supportsRaceRefueling } from "../contracts/race-rules";
import { useRaceStrategyHost } from "./host";
import type { LivePitData } from "@raceiq/shared/racing/live/types";

interface PitWindowProps {
  pit: LivePitData | null;
  gameId: GameId;
}

/**
 * PitWindow — Pit stop laps remaining + limited by indicator.
 * Pure component; all estimates are already normalized to laps.
 */
export function PitWindow({ pit, gameId }: PitWindowProps) {
  const { m } = useRaceStrategyHost();

  const pitIn = supportsRaceRefueling(gameId) || pit?.limitedBy !== "fuel" ? pit?.pitInLaps ?? null : null;
  const hasCountdown = pitIn != null && Number.isFinite(pitIn) && pitIn >= 0;
  const noLimiter = pit != null && pit.limitedBy === null && hasCountdown;
  const urgentColor = hasCountdown ? (pitIn <= 3 ? "text-(--severity-critical)" : pitIn <= 6 ? "text-(--severity-caution)" : "text-(--severity-nominal)") : "text-app-text-muted";

  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-1.5">
        <span className={`text-3xl font-mono font-black tabular-nums leading-none ${urgentColor}`}>{hasCountdown ? `~${pitIn.toFixed(1)}` : "—"}</span>
        <span className="text-xs text-app-text-muted">{m.pitwindow_laps()}</span>
      </div>
      <p className="mt-1 text-xs text-app-text-muted">
        {pit?.limitedBy === "fuel" ? supportsRaceRefueling(gameId) ? m.strategy_limited_fuel() : m.pit_timeline_projection_unavailable() : pit?.limitedBy === "tires" ? m.strategy_limited_tires() : noLimiter ? m.strategy_no_limiter() : m.pit_timeline_projection_unavailable()}
      </p>
    </div>
  );
}
