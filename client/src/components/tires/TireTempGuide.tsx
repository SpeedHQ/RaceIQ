import type { GameId } from "@raceiq/shared/games/ids";
import { getTireCoreTempGuide } from "@raceiq/shared/racing/live/tire-thresholds";
import { m } from "@/paraglide/messages";
import { Card } from "@/components/ui/card";
import { useUnits } from "@/hooks/useUnits";

function compoundLabel(compound: string): string {
  if (compound === "default") return m.threshold_default_compound();
  const words = compound.replace(/_compound$/, "").replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** Per-game optimal core-temperature windows published by game metadata. */
export function TireTempGuide({ gameId }: { gameId: GameId }) {
  const units = useUnits(gameId);
  const guide = getTireCoreTempGuide(gameId);
  if (guide.length === 0) return null;
  return (
    <section aria-labelledby="tire-temp-guide-title" className="min-w-0">
      <Card variant="transparent-panel" className="rounded-xl border border-app-border p-4">
        <h2 id="tire-temp-guide-title" className="text-app-heading font-semibold text-app-text">{m.tire_guide_title()}</h2>
        <p className="mt-1 text-xs text-app-text-muted">{m.tire_guide_description()}</p>
        <table className="mt-3 w-full text-left text-xs tabular-nums">
          <thead>
            <tr className="border-b border-app-border text-app-text-muted">
              <th scope="col" className="py-2 pr-3 font-medium">{m.tire_guide_compound()}</th>
              <th scope="col" className="py-2 font-medium">{m.tire_guide_optimal()} ({units.tempLabel})</th>
            </tr>
          </thead>
          <tbody>
            {guide.map((entry) => (
              <tr key={entry.compound} className="border-b border-app-border/60 last:border-0">
                <th scope="row" className="py-2 pr-3 font-medium text-app-text">{compoundLabel(entry.compound)}</th>
                <td className="py-2 font-mono">{units.temp(entry.min).toFixed(0)}–{units.temp(entry.max).toFixed(0)} {units.tempLabel}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}
