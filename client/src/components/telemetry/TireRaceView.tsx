import { useEffect, useRef, useState } from "react";
import type { TelemetryPacket } from "@shared/types";
import type { DisplayPacket } from "@/lib/convert-packet";
import { useUnits } from "@/hooks/useUnits";
import { useSettings } from "@/hooks/queries";
import { tireHealthTextClass, tireHealthBgClass, tireTempClass } from "@/lib/vehicle-dynamics";

/**
 * TireRaceView — Compact race-focused tire display.
 * Shows temp, wear %, grip state, and estimates laps remaining based on wear rate.
 */
export function TireRaceView({ packet }: { packet: DisplayPacket | TelemetryPacket }) {
  const units = useUnits();
  const { displaySettings } = useSettings();
  const healthThresh = displaySettings.tireHealthThresholds.values;
  const [wearInit] = useState(() => ({
    lastLap: 0,
    wearAtLapStart: [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR],
    wearRates: [] as number[][],
    lastWallTime: Date.now() / 1000,
    lastWear: [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR],
    wearPerSec: [0, 0, 0, 0],
  }));
  const wearRef = useRef(wearInit);
  const [wearState, setWearState] = useState({ wearPerSec: [0, 0, 0, 0], wearRates: [] as number[][] });

  // Track wear per lap for estimates
  useEffect(() => {
    const w = wearRef.current;
    if (packet.LapNumber > w.lastLap && w.lastLap > 0) {
      const currentWear = [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR];
      const deltas = currentWear.map((c, i) => w.wearAtLapStart[i] - c);
      if (deltas.every((d) => d >= 0 && d < 0.5)) {
        w.wearRates.push(deltas);
        if (w.wearRates.length > 10) w.wearRates.shift();
      }
      w.wearAtLapStart = currentWear;
    }
    w.lastLap = packet.LapNumber;
    setWearState({ wearPerSec: w.wearPerSec, wearRates: w.wearRates });
  }, [packet.LapNumber]);

  // Per-second wear rate tracking (wall clock, smoothed over ~3s)
  // TireWear increases as tires degrade (0=new, 1=gone), so delta = current - last
  useEffect(() => {
    const w = wearRef.current;
    const now = Date.now() / 1000;
    const dt = now - w.lastWallTime;
    if (dt >= 3) {
      const currentWear = [packet.TireWearFL, packet.TireWearFR, packet.TireWearRL, packet.TireWearRR];
      w.wearPerSec = currentWear.map((c, i) => {
        const delta = c - w.lastWear[i]; // wear increases as tire degrades
        return delta > 0 ? (delta / dt) * 100 : 0;
      });
      w.lastWallTime = now;
      w.lastWear = currentWear;
      setWearState({ wearPerSec: [...w.wearPerSec], wearRates: w.wearRates });
    }
  }, [packet]);

  const tires = [
    { label: "FL", temp: packet.TireTempFL, wear: packet.TireWearFL, grip: Math.abs(packet.TireCombinedSlipFL), wearPerSec: wearState.wearPerSec[0] },
    { label: "FR", temp: packet.TireTempFR, wear: packet.TireWearFR, grip: Math.abs(packet.TireCombinedSlipFR), wearPerSec: wearState.wearPerSec[1] },
    { label: "RL", temp: packet.TireTempRL, wear: packet.TireWearRL, grip: Math.abs(packet.TireCombinedSlipRL), wearPerSec: wearState.wearPerSec[2] },
    { label: "RR", temp: packet.TireTempRR, wear: packet.TireWearRR, grip: Math.abs(packet.TireCombinedSlipRR), wearPerSec: wearState.wearPerSec[3] },
  ];

  // Estimate laps remaining from worst tire
  let lapsEstimate: number | null = null;
  if (wearState.wearRates.length > 0) {
    const avgRates = [0, 1, 2, 3].map((i) => {
      const rates = wearState.wearRates.map((r) => r[i]).filter((r) => r > 0);
      return rates.length > 0 ? rates.reduce((s, v) => s + v, 0) / rates.length : 0;
    });
    const worstIdx = avgRates.indexOf(Math.max(...avgRates));
    if (avgRates[worstIdx] > 0) {
      lapsEstimate = Math.floor(tires[worstIdx].wear / avgRates[worstIdx]);
    }
  }

  return (
    <div>
      {/* 4 tires in 2x2 grid, full width */}
      <div className="grid grid-cols-2 gap-2">
        {tires.map((t) => {
          const healthPct = (1 - t.wear) * 100;
          const healthTxtClr = tireHealthTextClass(healthPct, healthThresh);
          const healthBg = tireHealthBgClass(healthPct, healthThresh);
          const tempDisplay = units.temp(t.temp);
          const tc = tireTempClass(t.temp, units.thresholds);

          return (
            <div key={t.label} className="bg-app-surface-alt/30 rounded-md p-2.5 flex items-center gap-2">
              {/* Vertical health bar */}
              <div className="flex flex-col items-center gap-1 shrink-0">
                <span className="text-xs font-bold text-app-text-muted">{t.label}</span>
                <div className="w-6 bg-app-surface rounded-sm overflow-hidden relative" style={{ height: 50 }}>
                  <div
                    className={`absolute bottom-0 w-full rounded-sm ${healthBg}`}
                    style={{ height: `${healthPct}%` }}
                  />
                </div>
              </div>
              {/* Health % — large */}
              <div className="flex-1 min-w-0">
                <span className={`text-3xl font-mono font-black tabular-nums leading-none ${healthTxtClr}`}>
                  {healthPct.toFixed(0)}%
                </span>
              </div>
              {/* Temp */}
              <div className="flex flex-col items-end shrink-0">
                <span className={`text-xl font-mono font-bold tabular-nums leading-none ${tc}`}>
                  {tempDisplay.toFixed(0)}°
                </span>
                <span className="text-[10px] font-mono text-app-text-dim">{units.tempUnit}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Tire summary: lap estimate */}
      <div className="flex items-center justify-end mt-2 px-1">
        {lapsEstimate != null && (
          <span className="text-[10px] font-mono text-app-text-muted">
            ~<span className={`font-bold ${lapsEstimate > 10 ? "text-emerald-400" : lapsEstimate > 5 ? "text-yellow-400" : "text-red-400"}`}>
              {lapsEstimate}
            </span> laps remaining
          </span>
        )}
      </div>
    </div>
  );
}
