import type { LivePitData, GameId } from "@shared/types";

interface PitWindowProps {
  pit: LivePitData | null;
  gameId: GameId | null;
}

/**
 * PitWindow — Pit stop laps remaining + limited by indicator.
 * Pure component; caller supplies pit + gameId.
 */
export function PitWindow({ pit, gameId }: PitWindowProps) {
  const fuelIsLitres = gameId === "acc" || gameId === "f1-2025";
  const fuelColor = fuelIsLitres
    ? (pit?.fuelLapsRemaining != null
        ? (pit.fuelLapsRemaining < 5 ? "text-red-400" : pit.fuelLapsRemaining < 15 ? "text-amber-400" : "text-emerald-400")
        : "text-app-text-dim")
    : "text-emerald-400";

  const pitIn = pit?.pitInLaps ?? null;
  const limitedBy = pit?.limitedBy ?? null;
  const urgentColor = pitIn != null
    ? (pitIn <= 3 ? "text-red-400" : pitIn <= 6 ? "text-amber-400" : "text-emerald-400")
    : "text-app-text-muted";

  return (
    <div className="flex items-baseline gap-2 shrink-0">
      <span className={`text-3xl font-mono font-black tabular-nums leading-none ${urgentColor}`}>
        {pitIn != null ? pitIn.toFixed(1) : "—"}
      </span>
      <span className="text-sm text-app-text-muted">laps</span>
      {pit != null && limitedBy && (
        <span className="text-base text-app-text-dim whitespace-nowrap">
          · limited by <span className={`font-bold ${limitedBy === "fuel" ? fuelColor : "text-app-text"}`}>{limitedBy}</span>
        </span>
      )}
    </div>
  );
}
