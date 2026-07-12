import type { TelemetryPacket, LiveSectorData, LivePitData } from "@shared/types";
import type { DisplayPacket } from "../../lib/convert-packet";
import { LapTimes } from "../telemetry/LapTimes";
import { SectorTimes } from "../SectorTimes";
import { TireGrid } from "../telemetry/TireGrid";
import { DashShell } from "./dash-shell";
import { FitToViewport } from "./FitToViewport";
import { RevBar } from "./RevBar";

interface ComboDashProps {
  rawPacket: TelemetryPacket | null;
  packet: DisplayPacket | null;
  sectors: LiveSectorData | null;
  pit: LivePitData | null;
  unitSystem: "metric" | "imperial";
  tireHealthThresholds?: { green: number; yellow: number };
  /** Convert a tire temperature from the game's native unit to °C. */
  toTempC: (t: number) => number;
}

function gearLabel(gear: number): string {
  if (gear <= 0) return "R";
  if (gear === 1) return "N";
  return String(gear - 1);
}

export function ComboDash({ rawPacket, packet, sectors, pit, unitSystem, tireHealthThresholds, toTempC }: ComboDashProps) {
  const fuelLaps = pit?.fuelLapsRemaining ?? null;
  const tireCliffs = pit?.tireEstimates?.toCliff ?? [];
  const tireLabels = ["FL", "FR", "RL", "RR"] as const;
  let weakestLabel: string | null = null;
  let weakestLaps: number | null = null;
  for (let i = 0; i < Math.min(tireCliffs.length, 4); i++) {
    const v = tireCliffs[i];
    if (v == null) continue;
    if (weakestLaps == null || v < weakestLaps) {
      weakestLaps = v;
      weakestLabel = tireLabels[i];
    }
  }

  const rpm = packet?.CurrentEngineRpm ?? 0;
  const idle = packet?.EngineIdleRpm ?? 0;
  const max = packet?.EngineMaxRpm ?? 10000;
  const gear = packet?.Gear ?? 1;
  const speed = packet?.DisplaySpeed ?? 0;
  const unit = unitSystem === "metric" ? "km/h" : "mph";
  const lapNumber = packet?.LapNumber ?? 0;
  const totalLaps = rawPacket?.f1?.totalLaps;
  const health = tireHealthThresholds ?? { green: 0.7, yellow: 0.4 };

  return (
    <DashShell>
      <div className="h-full w-full grid grid-cols-[3fr_1fr] grid-rows-[1fr_2fr_5fr] gap-3 p-4">
        <div className="relative flex items-center gap-3 min-h-0">
          <div className="flex-1 h-full">
            <RevBar rpm={rpm} idle={idle} max={max} segments={80} />
          </div>
          <div className="text-white/90 font-mono text-sm tabular-nums whitespace-nowrap">{Math.round(rpm).toLocaleString()} RPM</div>
        </div>

        <div className="row-span-2 min-h-0">
          <Tile label="REMAINING">
            <div className="space-y-2">
              <PitRow
                label="FUEL"
                value={fuelLaps != null ? fuelLaps.toFixed(1) : "—"}
                suffix="laps"
                color={fuelLaps == null ? "text-white/40" : fuelLaps < 3 ? "text-red-400" : fuelLaps < 8 ? "text-amber-400" : "text-emerald-400"}
              />
              <PitRow
                label={weakestLabel ? `TYRE (${weakestLabel})` : "TYRE"}
                value={weakestLaps != null ? weakestLaps.toFixed(1) : "—"}
                suffix="laps"
                color={weakestLaps == null ? "text-white/40" : weakestLaps < 3 ? "text-red-400" : weakestLaps < 8 ? "text-amber-400" : "text-emerald-400"}
              />
            </div>
          </Tile>
        </div>

        <div className="grid grid-cols-3 gap-3 min-h-0">
          <div className="min-w-0 min-h-0">
            <Tile label="GEAR">
              <div className="font-black leading-none" style={{ fontSize: "clamp(3rem, 14vh, 8rem)" }}>
                {gearLabel(gear)}
              </div>
            </Tile>
          </div>
          <div className="min-w-0 min-h-0">
            <Tile label={unit.toUpperCase()}>
              <div className="font-black leading-none" style={{ fontSize: "clamp(2.5rem, 13vh, 7rem)" }}>
                {Math.round(speed)}
              </div>
            </Tile>
          </div>
          <div className="min-w-0 min-h-0">
            <Tile label="LAP">
              <div className="font-black leading-none tabular-nums" style={{ fontSize: "clamp(2.5rem, 13vh, 7rem)" }}>
                {lapNumber > 0 ? lapNumber : "-"}
                {totalLaps && totalLaps > 0 ? <span className="text-white/40">/{totalLaps}</span> : null}
              </div>
            </Tile>
          </div>
        </div>

        <div className="col-span-2 min-h-0 flex gap-3">
          <div className="flex-[3] min-w-0 min-h-0 rounded-md border border-white/10 bg-white/[0.02] overflow-hidden">
            {rawPacket ? (
              <FitToViewport padding={12} alignX="start" alignY="center">
                <div style={{ width: 560 }} className="space-y-3">
                  <LapTimes packet={rawPacket} sectors={sectors} />
                  <SectorTimes sectors={sectors} />
                </div>
              </FitToViewport>
            ) : (
              <div className="h-full flex items-center justify-center text-white/40 text-sm tracking-widest uppercase">Waiting for lap data…</div>
            )}
          </div>

          <div className="flex-[2] min-w-0 min-h-0 rounded-md border border-white/10 bg-white/[0.02] overflow-hidden">
            {rawPacket ? (
              <FitToViewport padding={4} maxScale={5}>
                <div style={{ width: 400 }} className="[&>div>:first-child]:hidden">
                  <TireGrid
                    fl={{
                      tempC: Math.round(toTempC(rawPacket.TireTempFL)),
                      wear: rawPacket.TireWearFL,
                      brakeTemp: rawPacket.BrakeTempFrontLeft,
                      pressure: rawPacket.TirePressureFrontLeft,
                    }}
                    fr={{
                      tempC: Math.round(toTempC(rawPacket.TireTempFR)),
                      wear: rawPacket.TireWearFR,
                      brakeTemp: rawPacket.BrakeTempFrontRight,
                      pressure: rawPacket.TirePressureFrontRight,
                    }}
                    rl={{
                      tempC: Math.round(toTempC(rawPacket.TireTempRL)),
                      wear: rawPacket.TireWearRL,
                      brakeTemp: rawPacket.BrakeTempRearLeft,
                      pressure: rawPacket.TirePressureRearLeft,
                    }}
                    rr={{
                      tempC: Math.round(toTempC(rawPacket.TireTempRR)),
                      wear: rawPacket.TireWearRR,
                      brakeTemp: rawPacket.BrakeTempRearRight,
                      pressure: rawPacket.TirePressureRearRight,
                    }}
                    healthThresholds={health}
                    tempThresholds={{ blue: 60, orange: 85, red: 100 }}
                  />
                </div>
              </FitToViewport>
            ) : (
              <div className="h-full flex items-center justify-center text-white/40 text-sm tracking-widest uppercase">Waiting for tire data…</div>
            )}
          </div>
        </div>
      </div>
    </DashShell>
  );
}

function PitRow({
  label,
  value,
  suffix,
  color,
}: {
  label: string;
  value: string;
  suffix: string;
  color: string;
}) {
  return (
    <div>
      <div className="text-white/40 text-xs tracking-widest uppercase">{label}</div>
      <div className={`font-black leading-none tabular-nums ${color}`} style={{ fontSize: "2.5rem" }}>
        {value}
        <span className="text-white/40 text-base font-semibold ml-2">{suffix}</span>
      </div>
    </div>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative rounded-md border border-white/10 bg-white/[0.02] flex flex-col overflow-hidden min-w-0 min-h-0 h-full">
      <div className="shrink-0 text-white/40 text-xs tracking-widest uppercase px-3 pt-2">{label}</div>
      <div className="flex-1 min-h-0">
        <FitToViewport padding={6}>{children}</FitToViewport>
      </div>
    </div>
  );
}
