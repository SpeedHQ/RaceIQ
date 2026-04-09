import type { TelemetryPacket } from "@shared/types";
import { useSettings } from "@/hooks/queries";
import { useGameId } from "@/stores/game";
import { useTelemetryStore } from "@/stores/telemetry";
import { tireHealthTextClass, tireHealthBgClass } from "@/lib/vehicle-dynamics";

/**
 * PitEstimate — Displays server-computed fuel and tire estimates.
 * All computation happens server-side in PitTracker; this component just renders.
 */
export function PitEstimate({ packet }: { packet: TelemetryPacket }) {
  const gameId = useGameId();
  const { displaySettings } = useSettings();
  const healthThresh = displaySettings.tireHealthThresholds.values;
  const pit = useTelemetryStore((s) => s.pit);

  // Forza: Fuel is 0..1 fraction → percentage. ACC/F1: Fuel is in litres/kg.
  const fuelIsLitres = gameId === "acc" || gameId === "f1-2025";
  const fuelPct = fuelIsLitres ? Math.min(100, packet.Fuel) : (packet.Fuel * 100);
  const fuelDisplay = fuelIsLitres ? `${packet.Fuel.toFixed(1)}L` : `${fuelPct.toFixed(0)}%`;
  const fuelColor = fuelIsLitres
    ? (packet.Fuel < 5 ? "text-red-400" : packet.Fuel < 15 ? "text-amber-400" : "text-emerald-400")
    : (fuelPct < 20 ? "text-red-400" : fuelPct < 40 ? "text-amber-400" : "text-emerald-400");

  const fuelLaps = pit?.fuelLapsRemaining ?? null;

  // Per-tire display from live packet + server thresholds
  const tireLabels = ["FL", "FR", "RL", "RR"];
  const wears = [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR];
  const tireData = tireLabels.map((label, i) => {
    const health = (1 - wears[i]) * 100;
    return {
      label,
      health,
      healthClr: tireHealthTextClass(health, healthThresh),
      healthBg: tireHealthBgClass(health, healthThresh),
    };
  });

  // Server-computed pit window
  const hasEstimates = pit != null && (pit.fuelLapsRemaining != null || pit.tireLapsToBad != null);
  const pitIn = pit?.pitInLaps ?? null;
  const limitedBy = pit?.limitedBy ?? null;
  const urgentColor = pitIn != null
    ? (pitIn <= 3 ? "text-red-400" : pitIn <= 6 ? "text-amber-400" : "text-emerald-400")
    : "text-app-text-muted";

  return (
    <div>
      {/* Pit in: limited by + lap count */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-lg font-semibold text-app-text-secondary">
          {hasEstimates && limitedBy ? (
            <>Limited by <span className={`font-bold ${limitedBy === "fuel" ? fuelColor : "text-app-text"}`}>{limitedBy}</span></>
          ) : (
            <span className="text-app-text-dim">Estimating...</span>
          )}
        </div>
        <span className={`text-3xl font-mono font-black tabular-nums leading-none ${urgentColor}`}>
          {pitIn != null ? (
            <>{pitIn.toFixed(1)} <span className="text-base font-bold">laps</span></>
          ) : (
            <span className="text-app-text-dim">— <span className="text-base font-bold">laps</span></span>
          )}
        </span>
      </div>

      {/* Column headers */}
      <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 items-end mb-1 px-1">
        <div />
        <div className="text-[9px] text-app-text-dim uppercase tracking-wider text-center w-14">Level</div>
        <div className="text-[9px] text-app-text-dim uppercase tracking-wider text-center w-16">Est. Laps</div>
      </div>

      <div className="space-y-2">
        {/* Fuel row */}
        <div className="bg-app-surface/50 rounded-md p-2.5">
          <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1.5">Fuel</div>
          <div className="grid grid-cols-[1fr_auto_auto] gap-x-3 items-end">
            <div className="h-2.5 bg-app-surface-alt rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${fuelPct < 20 ? "bg-red-500" : fuelPct < 40 ? "bg-amber-400" : "bg-emerald-400"}`} style={{ width: `${fuelPct}%` }} />
            </div>
            <div className={`text-2xl font-mono font-black tabular-nums leading-none text-right ${fuelIsLitres ? "w-20" : "w-14"} ${fuelColor}`}>
              {fuelDisplay}
            </div>
            <div className={`text-2xl font-mono font-black tabular-nums leading-none text-right w-16 ${fuelLaps != null ? fuelColor : "text-app-text-dim"}`}>
              {fuelLaps != null ? `~${fuelLaps.toFixed(1)}` : "—"}
            </div>
          </div>
        </div>

        {/* Tire section */}
        <div className="bg-app-surface/50 rounded-md p-2.5">
          <div className="flex items-center justify-between mb-1.5">
            <div className="text-[10px] text-app-text-muted uppercase tracking-wider">Tires</div>
            {pit?.tireLapsToBad != null && (
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-app-text-dim">
                  To cliff <span className="font-mono font-bold text-amber-400">~{pit.tireLapsToBad.toFixed(1)}</span>
                </span>
                {pit.tireLapsToCritical != null && (
                  <span className="text-[10px] text-app-text-dim">
                    To dead <span className="font-mono font-bold text-red-400">~{pit.tireLapsToCritical.toFixed(1)}</span>
                  </span>
                )}
              </div>
            )}
          </div>
          {tireData.map((t) => (
            <div key={t.label} className="grid grid-cols-[auto_1fr_auto] gap-x-3 items-center py-1">
              <div className="text-xs font-bold text-app-text-muted w-5">{t.label}</div>
              <div className="h-2.5 bg-app-surface-alt rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${t.healthBg}`} style={{ width: `${t.health}%` }} />
              </div>
              <div className={`text-xl font-mono font-black tabular-nums leading-none text-right w-14 ${t.healthClr}`}>
                {t.health.toFixed(0)}%
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Estimate source */}
      {pit?.estimateSource && (
        <div className="mt-2 text-[10px] text-app-text-dim italic">
          {pit.estimateSource === "history"
            ? "* based on previous session laps"
            : "* based on current session laps"}
        </div>
      )}
    </div>
  );
}
