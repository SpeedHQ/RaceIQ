import { hasTireHealthData, resolveAnalysisTelemetry } from "@shared/games/analysis-telemetry";
import { getGame } from "@shared/games/registry";
import { getFuelDisplay } from "@shared/games/telemetry";
import type { LivePitData, TelemetryPacket } from "@shared/types";
import { severityColor } from "@/lib/colors";
import { tireHealthPctColor } from "@/lib/vehicle-dynamics";
import { m } from "@/paraglide/messages";
import { PitWindow } from "./PitWindow";

interface PitEstimateProps {
  packet: TelemetryPacket;
  pit: LivePitData | null;
}

/**
 * PitEstimate — Displays server-computed fuel and tire estimates.
 * All computation happens server-side in PitTracker; this component just renders.
 */
export function PitEstimate({ packet, pit }: PitEstimateProps) {
  const adapter = getGame(packet.gameId);
  const telemetryModel = adapter.telemetry;
  const analysis = resolveAnalysisTelemetry(adapter);
  const healthAvailable = hasTireHealthData(packet, analysis.tireHealth);
  const fuel = getFuelDisplay(packet, telemetryModel.fuel);
  const fuelPct = fuel.fillRatio === undefined ? undefined : fuel.fillRatio * 100;
  const isFuelCritical = fuel.fillRatio === undefined ? fuel.amount < 5 : fuel.fillRatio < 0.2;
  const isFuelWarning = !isFuelCritical && (fuel.fillRatio === undefined ? fuel.amount < 15 : fuel.fillRatio < 0.4);
  const fuelColor = severityColor(isFuelCritical ? 3 : isFuelWarning ? 1 : 0);

  const fuelLaps = pit?.fuelLapsRemaining ?? null;

  // Per-tire display
  const tireLabels = ["FL", "FR", "RL", "RR"] as const;
  const wears = [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR];
  const tireData = tireLabels.map((label, i) => {
    const health = healthAvailable ? (1 - wears[i]) * 100 : null;
    const canEstimateWear = analysis.tireWearRate.source !== "unavailable";
    const wpl = canEstimateWear ? (pit?.tireEstimates?.wearPerLap[i] ?? 0) : 0;
    return {
      label,
      health,
      healthColor: health === null ? "var(--status-unavailable)" : tireHealthPctColor(health),
      toCliff: canEstimateWear ? (pit?.tireEstimates?.toCliff[i] ?? null) : null,
      toDead: canEstimateWear ? (pit?.tireEstimates?.toDead[i] ?? null) : null,
      wearPerLap: wpl > 0 ? (wpl * 100).toFixed(1) : null,
    };
  });

  const pitStatus = telemetryModel.pitStatus ? (packet.acc?.pitStatus ?? (packet.iracing?.onPitRoad ? "pit_lane" : "out")) : undefined;
  const pitBadge = pitStatus === "in_pit" ? { label: m.pit_in_pit(), color: "var(--status-info)" } : pitStatus === "pit_lane" ? { label: m.pit_pit_lane(), color: "var(--status-warning)" } : null;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        {pitBadge ? (
          <span
            className="text-xs font-bold px-2 py-0.5 rounded border tracking-widest uppercase bg-(--pit-badge-color)/20 border-(--pit-badge-color)/30 text-(--pit-badge-color)"
            style={{ ["--pit-badge-color" as string]: pitBadge.color }}
          >
            {pitBadge.label}
          </span>
        ) : (
          <span />
        )}
        <PitWindow pit={pit} />
      </div>
      <div className="space-y-3">
        {/* Fuel row */}
        <div className="py-1">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs text-app-text-muted uppercase tracking-wider font-semibold">{m.telemetry_fuel()}</div>
            <div className="text-lg font-mono font-bold tabular-nums" style={{ color: fuelLaps != null ? fuelColor : "var(--app-text-dim)" }}>
              {fuelLaps != null ? `~${fuelLaps.toFixed(1)} laps` : "—"}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {fuelPct === undefined ? (
              <div className="flex-1 h-3 rounded-full border border-dashed border-app-border" title="Fuel capacity unavailable" />
            ) : (
              <div className="flex-1 h-3 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ backgroundColor: fuelColor, width: `${fuelPct}%` }} />
              </div>
            )}
            <div className={`text-2xl font-mono font-black tabular-nums leading-none ${fuel.unit === "L" ? "w-20" : "w-14"} text-right`} style={{ color: fuelColor }}>
              {fuel.amount.toFixed(fuel.unit === "L" ? 1 : 0)}
              {fuel.unit}
            </div>
          </div>
        </div>

        {/* Tire section */}
        <div className="py-1">
          <div className="text-xs text-app-text-muted uppercase tracking-wider font-semibold mb-2">
            {analysis.tireHealth.source === "direct" && analysis.tireHealth.freshness === "pit-snapshot" ? m.analyse_wheels_pit_health() : m.label_tires()}
          </div>

          {/* Column headers */}
          <div className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-x-2 items-center mb-1 px-0.5">
            <div className="w-6" />
            <div />
            <div className="text-app-caption text-app-text-dim uppercase tracking-wider text-right w-12">{m.pit_health()}</div>
            <div className="text-app-caption text-app-text-dim uppercase tracking-wider text-right w-14">{m.pit_wear_lap()}</div>
            <div className="text-app-caption uppercase tracking-wider text-right w-12 text-(--severity-caution)/70">
              {m.pit_cliff()}
              {pit?.cliffPct ? ` ${pit.cliffPct}%` : ""}
            </div>
            <div className="text-app-caption uppercase tracking-wider text-right w-12 text-(--severity-critical)/70">
              {m.pit_dead()}
              {pit?.deadPct ? ` ${pit.deadPct}%` : ""}
            </div>
          </div>
          {tireData.map((t) => (
            <div key={t.label} className="grid grid-cols-[auto_1fr_auto_auto_auto_auto] gap-x-2 items-center py-1.5 px-0.5">
              <div className="text-sm font-bold text-app-text-muted w-6">{t.label}</div>
              <div className="h-3 rounded-full overflow-hidden">
                <div className="h-full rounded-full" style={{ backgroundColor: t.healthColor, width: t.health === null ? 0 : `${t.health}%` }} />
              </div>
              <div className="text-lg font-mono font-black tabular-nums leading-none text-right w-12" style={{ color: t.healthColor }}>
                {t.health === null ? "—" : `${t.health.toFixed(0)}%`}
              </div>
              <div className={`text-sm font-mono font-bold tabular-nums leading-none text-right w-14 ${t.wearPerLap ? "text-app-text-secondary" : "text-app-text-dim"}`}>
                {t.wearPerLap ? `${t.wearPerLap}%` : "—"}
              </div>
              <div className="text-lg font-mono font-bold tabular-nums leading-none text-right w-12" style={{ color: t.toCliff != null ? "var(--severity-caution)" : "var(--app-text-dim)" }}>
                {t.toCliff != null ? t.toCliff.toFixed(1) : "—"}
              </div>
              <div className="text-lg font-mono font-bold tabular-nums leading-none text-right w-12" style={{ color: t.toDead != null ? "var(--severity-critical)" : "var(--app-text-dim)" }}>
                {t.toDead != null ? t.toDead.toFixed(1) : "—"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
