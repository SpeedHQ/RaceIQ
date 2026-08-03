import { m } from "@/paraglide/messages";
import type { LivePitData } from "../../../../shared/live/types";

interface PitWindowProps {
  pit: LivePitData | null;
}

/**
 * PitWindow — Pit stop laps remaining + limited by indicator.
 * Pure component; all estimates are already normalized to laps.
 */
export function PitWindow({ pit }: PitWindowProps) {
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
    <div className="flex items-baseline gap-2 shrink-0">
      <span className={`text-3xl font-mono font-black tabular-nums leading-none ${urgentColor}`}>{pitIn != null ? pitIn.toFixed(1) : "—"}</span>
      <span className="text-sm text-app-text-muted">{m.pitwindow_laps()}</span>
      {pit != null && limitedBy && (
        <span className="text-base text-app-text-dim whitespace-nowrap">
          · {m.pitwindow_limited_by()} <span className={`font-bold ${limitedBy === "fuel" ? fuelColor : "text-app-text"}`}>{limitedBy}</span>
        </span>
      )}
    </div>
  );
}
