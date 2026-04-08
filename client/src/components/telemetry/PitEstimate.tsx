import { useEffect, useRef, useState } from "react";
import type { TelemetryPacket } from "@shared/types";
import { client } from "@/lib/rpc";
import { useSettings } from "@/hooks/queries";
import { useGameId } from "@/stores/game";
import { tireHealthTextClass, tireHealthBgClass } from "@/lib/vehicle-dynamics";

/**
 * PitEstimate — Tracks fuel burn and tire wear per lap to estimate
 * how many laps remain before needing to pit. Shows whichever
 * runs out first as the pit window.
 */
export function PitEstimate({ packet }: { packet: TelemetryPacket }) {
  const gameId = useGameId();
  const { displaySettings } = useSettings();
  const healthThresh = displaySettings.tireHealthThresholds.values;
  const [trackLength, setTrackLength] = useState<number>(0);
  const trackOrdRef = useRef<number>(0);

  // Fetch track length from sector boundaries
  useEffect(() => {
    if (!packet.TrackOrdinal || packet.TrackOrdinal === trackOrdRef.current) return;
    trackOrdRef.current = packet.TrackOrdinal;
    if (!gameId) return;
    client.api["track-sector-boundaries"][":ordinal"].$get({ param: { ordinal: String(packet.TrackOrdinal) }, query: { gameId: gameId! } })
      .then((r) => r.json() as Promise<{ trackLength?: number }>)
      .then((data) => { if (data?.trackLength) setTrackLength(data.trackLength); })
      .catch(() => {});
  }, [packet.TrackOrdinal, gameId]);

  const [pitInitial] = useState(() => ({
    lastWallTime: Date.now() / 1000,
    lastFuel: packet.Fuel,
    lastWorstWear: Math.max(packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR),
    lastDist: packet.DistanceTraveled,
    fuelPerSec: 0,
    wearPerSec: 0,
    avgSpeed: 0,
  }));
  const pitRef = useRef(pitInitial);
  const [pitRates, setPitRates] = useState({ fuelPerSec: 0, wearPerSec: 0, avgSpeed: 0 });

  // Per-second rate tracking (wall clock, smoothed over ~3s)
  useEffect(() => {
    const s = pitRef.current;
    const now = Date.now() / 1000;
    const dt = now - s.lastWallTime;
    if (dt >= 3) {
      const fuelDelta = s.lastFuel - packet.Fuel; // fuel decreases
      const worstWear = Math.max(packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR);
      const wearDelta = worstWear - s.lastWorstWear; // wear increases
      const distDelta = packet.DistanceTraveled - s.lastDist;

      if (fuelDelta > 0) s.fuelPerSec = (fuelDelta / dt) * 100;
      if (wearDelta > 0) s.wearPerSec = (wearDelta / dt) * 100;
      if (distDelta > 0) s.avgSpeed = distDelta / dt; // m/s

      s.lastWallTime = now;
      s.lastFuel = packet.Fuel;
      s.lastWorstWear = worstWear;
      s.lastDist = packet.DistanceTraveled;
      setPitRates({ fuelPerSec: s.fuelPerSec, wearPerSec: s.wearPerSec, avgSpeed: s.avgSpeed });
    }
  }, [packet]);

  // Estimate laps from rate-based calculation:
  // usagePerLap = usagePerSec * (trackLength / avgSpeed)
  // lapsRemaining = currentLevel / usagePerLap
  const canEstimate = pitRates.avgSpeed > 1 && trackLength && trackLength > 100;
  const estLapTime = canEstimate ? trackLength / pitRates.avgSpeed : 0;

  let fuelLaps: number | null = null;
  if (pitRates.fuelPerSec > 0 && canEstimate) {
    const fuelPerLap = (pitRates.fuelPerSec / 100) * estLapTime; // fraction per lap
    if (fuelPerLap > 0) fuelLaps = Math.round((packet.Fuel / fuelPerLap) * 10) / 10;
  }

  // Per-tire calculations
  const tireLabels = ["FL", "FR", "RL", "RR"];
  const wears = [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR];
  const tireData = tireLabels.map((label, i) => {
    const health = (1 - wears[i]) * 100;
    const healthClr = tireHealthTextClass(health, healthThresh);
    const healthBg = tireHealthBgClass(health, healthThresh);
    let laps: number | null = null;
    if (pitRates.wearPerSec > 0 && canEstimate) {
      const wearPerLap = (pitRates.wearPerSec / 100) * estLapTime;
      const remaining = 1 - wears[i];
      if (wearPerLap > 0) laps = Math.round((remaining / wearPerLap) * 10) / 10;
    }
    return { label, health, healthClr, healthBg, laps };
  });

  // Forza: Fuel is 0..1 fraction → percentage. ACC/F1: Fuel is in litres/kg.
  const fuelIsLitres = gameId === "acc" || gameId === "f1-2025";
  const fuelPct = fuelIsLitres ? Math.min(100, packet.Fuel) : (packet.Fuel * 100); // clamp litres for bar width
  const fuelDisplay = fuelIsLitres ? `${packet.Fuel.toFixed(1)}L` : `${fuelPct.toFixed(0)}%`;
  const fuelColor = fuelIsLitres
    ? (packet.Fuel < 5 ? "text-red-400" : packet.Fuel < 15 ? "text-amber-400" : "text-emerald-400")
    : (fuelPct < 20 ? "text-red-400" : fuelPct < 40 ? "text-amber-400" : "text-emerald-400");

  // Pit in = min of fuel laps and worst tire laps
  const worstTireLaps = tireData.reduce<number | null>((min, t) => {
    if (t.laps == null) return min;
    return min == null ? t.laps : Math.min(min, t.laps);
  }, null);
  const hasEstimates = fuelLaps != null || worstTireLaps != null;
  const pitIn = hasEstimates
    ? (fuelLaps != null && worstTireLaps != null ? Math.min(fuelLaps, worstTireLaps) : fuelLaps ?? worstTireLaps!)
    : null;
  const limitedBy = fuelLaps != null && worstTireLaps != null
    ? (fuelLaps <= worstTireLaps ? "fuel" : "tires")
    : fuelLaps != null ? "fuel" : "tires";
  const urgentColor = pitIn != null
    ? (pitIn <= 3 ? "text-red-400" : pitIn <= 6 ? "text-amber-400" : "text-emerald-400")
    : "text-app-text-muted";

  return (
    <div>
      {/* Pit in: limited by + lap count */}
      <div className="flex items-center justify-between mb-2">
        <div className="text-lg font-semibold text-app-text-secondary">
          {hasEstimates ? (
            <>Limited by <span className={`font-bold ${limitedBy === "fuel" ? fuelColor : (tireData.find(t => t.laps === worstTireLaps)?.healthClr ?? "text-app-text")}`}>{limitedBy}</span></>
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
      <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 items-end mb-1 px-1">
        <div />
        <div className="text-[9px] text-app-text-dim uppercase tracking-wider text-center w-14">Level</div>
        <div className="text-[9px] text-app-text-dim uppercase tracking-wider text-center w-16">Est. Laps</div>
        <div className="text-[9px] text-app-text-dim uppercase tracking-wider text-center w-16">Use /5s</div>
      </div>

      <div className="space-y-2">
        {/* Fuel row */}
        <div className="bg-app-surface/50 rounded-md p-2.5">
          <div className="text-[10px] text-app-text-muted uppercase tracking-wider mb-1.5">Fuel</div>
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-3 items-end">
            <div className="h-2.5 bg-app-surface-alt rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${fuelPct < 20 ? "bg-red-500" : fuelPct < 40 ? "bg-amber-400" : "bg-emerald-400"}`} style={{ width: `${fuelPct}%` }} />
            </div>
            <div className={`text-2xl font-mono font-black tabular-nums leading-none text-right ${fuelIsLitres ? "w-20" : "w-14"} ${fuelColor}`}>
              {fuelDisplay}
            </div>
            <div className={`text-2xl font-mono font-black tabular-nums leading-none text-right w-16 ${fuelLaps != null ? fuelColor : "text-app-text-dim"}`}>
              {fuelLaps != null ? `~${fuelLaps.toFixed(1)}` : "—"}
            </div>
            <div className={`text-lg font-mono font-bold tabular-nums leading-none text-right w-16 ${pitRates.fuelPerSec > 0 ? fuelColor : "text-app-text-dim"}`}>
              {pitRates.fuelPerSec > 0 ? (pitRates.fuelPerSec * 5).toFixed(2) : "—"}
            </div>
          </div>
        </div>

        {/* Per-tire health rows */}
        {tireData.map((t) => (
          <div key={t.label} className="grid grid-cols-[auto_1fr_auto_auto_auto] gap-x-3 items-center px-2.5 py-1.5">
            <div className="text-xs font-bold text-app-text-muted w-5">{t.label}</div>
            <div className="h-2.5 bg-app-surface-alt rounded-full overflow-hidden">
              <div className={`h-full rounded-full ${t.healthBg}`} style={{ width: `${t.health}%` }} />
            </div>
            <div className={`text-xl font-mono font-black tabular-nums leading-none text-right w-14 ${t.healthClr}`}>
              {t.health.toFixed(0)}%
            </div>
            <div className={`text-xl font-mono font-black tabular-nums leading-none text-right w-16 ${t.laps != null ? t.healthClr : "text-app-text-dim"}`}>
              {t.laps != null ? `~${t.laps.toFixed(1)}` : "—"}
            </div>
            <div className={`text-lg font-mono font-bold tabular-nums leading-none text-right w-16 ${pitRates.wearPerSec > 0 ? t.healthClr : "text-app-text-dim"}`}>
              {pitRates.wearPerSec > 0 ? (pitRates.wearPerSec * 5).toFixed(2) : "—"}
            </div>
          </div>
        ))}
      </div>

    </div>
  );
}
