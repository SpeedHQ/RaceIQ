import type { TelemetryPacket } from "@shared/types";
import { useSettings } from "@/hooks/queries";
import { useGameId } from "@/stores/game";
import { useTelemetryStore } from "@/stores/telemetry";
import { tireHealthTextClass, tireHealthBgClass } from "@/lib/vehicle-dynamics";
import { PitWindow } from "./PitWindow";

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

  // Per-tire display
  const tireLabels = ["FL", "FR", "RL", "RR"] as const;
  const wears = [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR];
  const tireData = tireLabels.map((label, i) => {
    const health = (1 - wears[i]) * 100;
    const wpl = pit?.tireEstimates?.wearPerLap[i] ?? 0;
    return {
      label,
      health,
      healthClr: tireHealthTextClass(health, healthThresh),
      healthBg: tireHealthBgClass(health, healthThresh),
      toCliff: pit?.tireEstimates?.toCliff[i] ?? null,
      toDead: pit?.tireEstimates?.toDead[i] ?? null,
      wearPerLap: wpl > 0 ? (wpl * 100).toFixed(1) : null,
    };
  });

  const pitStatus = packet.acc?.pitStatus;
  const pitBadge =
    pitStatus === "in_pit"   ? { label: "IN PIT",   cls: "bg-sky-500/20 text-sky-300 border-sky-500/30" } :
    pitStatus === "pit_lane" ? { label: "PIT LANE", cls: "bg-amber-500/20 text-amber-300 border-amber-500/30" } :
    null;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        {pitBadge ? (
          <span className={`text-xs font-bold px-2 py-0.5 rounded border tracking-widest uppercase ${pitBadge.cls}`}>
            {pitBadge.label}
          </span>
        ) : <span />}
        <PitWindow />
      </div>
      <div className="space-y-3">
        {/* Fuel row */}
        <div className="py-1">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-app-text-muted uppercase tracking-wider font-semibold">Fuel</div>
            <div className={`text-lg font-mono font-bold tabular-nums ${fuelLaps != null ? fuelColor : "text-app-text-dim"}`}>
              {fuelLaps != null ? `~${fuelLaps.toFixed(1)} laps` : "—"}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 h-3 rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${fuelPct < 20 ? "bg-red-500" : fuelPct < 40 ? "bg-amber-400" : "bg-emerald-400"}`} style={{ width: `${fuelPct}%` }} />
            </div>
            <div className={`text-2xl font-mono font-black tabular-nums leading-none ${fuelIsLitres ? "w-20" : "w-14"} text-right ${fuelColor}`}>
              {fuelDisplay}
            </div>
          </div>
        </div>

        {/* Tire section */}
        <div className="py-1">
          <div className="text-xs text-app-text-muted uppercase tracking-wider font-semibold mb-2">Tires</div>

          {/* Column headers */}
          <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-x-2 items-center mb-1 px-0.5">
            <div className="w-6" />
            <div />
            <div className="text-[10px] text-app-text-dim uppercase tracking-wider text-right w-12">Health</div>
            <div className="text-[10px] text-app-text-dim uppercase tracking-wider text-right w-14">Wear/lap</div>
            <div className="text-[10px] text-amber-400/70 uppercase tracking-wider text-right w-12">Cliff{pit?.cliffPct ? ` ${pit.cliffPct}%` : ""}</div>
            <div className="text-[10px] text-red-400/70 uppercase tracking-wider text-right w-12">Dead{pit?.deadPct ? ` ${pit.deadPct}%` : ""}</div>
          </div>

          {tireData.map((t) => (
            <div key={t.label} className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-x-2 items-center py-1.5 px-0.5">
              <div className="text-sm font-bold text-app-text-muted w-6">{t.label}</div>
              <div className="h-3 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${t.healthBg}`} style={{ width: `${t.health}%` }} />
              </div>
              <div className={`text-lg font-mono font-black tabular-nums leading-none text-right w-12 ${t.healthClr}`}>
                {t.health.toFixed(0)}%
              </div>
              <div className={`text-sm font-mono font-bold tabular-nums leading-none text-right w-14 ${t.wearPerLap ? "text-app-text-secondary" : "text-app-text-dim"}`}>
                {t.wearPerLap ? `${t.wearPerLap}%` : "—"}
              </div>
              <div className={`text-lg font-mono font-bold tabular-nums leading-none text-right w-12 ${t.toCliff != null ? "text-amber-400" : "text-app-text-dim"}`}>
                {t.toCliff != null ? t.toCliff.toFixed(1) : "—"}
              </div>
              <div className={`text-lg font-mono font-bold tabular-nums leading-none text-right w-12 ${t.toDead != null ? "text-red-400" : "text-app-text-dim"}`}>
                {t.toDead != null ? t.toDead.toFixed(1) : "—"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
