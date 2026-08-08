import type { LivePitData, LiveSectorData } from "../../../../shared/racing/live/types";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";
import type { DisplayPacket } from "../../lib/convert-packet";
import type { LiveTelemetryView } from "../../lib/live-telemetry-view";
import { SectorTimes } from "../SectorTimes";
import { LapTimes } from "../telemetry/LapTimes";
import { TireGrid } from "../telemetry/TireGrid";
import { DashShell } from "./dash-shell";
import { FitToViewport } from "./FitToViewport";
import { RevBar } from "./RevBar";
interface ComboDashProps {
  rawPacket?: TelemetryPacket | null;
  packet?: DisplayPacket | null;
  view?: LiveTelemetryView | null;
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
export function ComboDash({ rawPacket, packet, view, sectors, pit, unitSystem, tireHealthThresholds, toTempC }: ComboDashProps) {
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
  const rpm = view?.engine.rpm ?? packet?.CurrentEngineRpm ?? 0;
  const idle = view?.engine.idleRpm ?? packet?.EngineIdleRpm ?? 0;
  const max = view?.engine.maxRpm ?? packet?.EngineMaxRpm ?? 10000;
  const gear = view?.inputs.gear ?? packet?.Gear ?? 1;
  const speed = view ? ((view.motion.speedMps ?? 0) * (unitSystem === "metric" ? 3.6 : 2.23694)) : (packet?.DisplaySpeed ?? 0);
  const unit = unitSystem === "metric" ? "km/h" : "mph";
  const lapNumber = view?.timing.lapNumber ?? packet?.LapNumber ?? 0;
  const totalLaps = view?.timing.totalLaps ?? rawPacket?.f1?.totalLaps;
  const health = tireHealthThresholds ?? { green: 0.7, yellow: 0.4 };
  const tires = view?.tires;
  const hasTelemetry = !!(view || rawPacket);

  return (
    <DashShell>
      <div className="h-full w-full grid grid-cols-[3fr_1fr] grid-rows-[1fr_2fr_5fr] gap-3 p-4">
        <div className="relative flex items-center gap-3 min-h-0">
          <div className="flex-1 h-full">
            <RevBar rpm={rpm} idle={idle} max={max} segments={80} />
          </div>
          <div className="text-app-text/90 font-mono text-sm tabular-nums whitespace-nowrap">{Math.round(rpm).toLocaleString()} RPM</div>
        </div>

        <div className="row-span-2 min-h-0">
          <Tile label="REMAINING">
            <div className="space-y-2">
              <PitRow
                label="FUEL"
                value={fuelLaps != null ? fuelLaps.toFixed(1) : "—"}
                suffix="laps"
                color={fuelLaps == null ? "text-app-text/40" : fuelLaps < 3 ? "text-(--severity-critical)" : fuelLaps < 8 ? "text-(--severity-caution)" : "text-(--severity-nominal)"}
              />
              <PitRow
                label={weakestLabel ? `TYRE (${weakestLabel})` : "TYRE"}
                value={weakestLaps != null ? weakestLaps.toFixed(1) : "—"}
                suffix="laps"
                color={weakestLaps == null ? "text-app-text/40" : weakestLaps < 3 ? "text-(--severity-critical)" : weakestLaps < 8 ? "text-(--severity-caution)" : "text-(--severity-nominal)"}
              />
            </div>
          </Tile>
        </div>

        <div className="grid grid-cols-3 gap-3 min-h-0">
          <div className="min-w-0 min-h-0">
            <Tile label="GEAR">
              <div className="text-app-instrument-primary font-black leading-none">{gearLabel(gear)}</div>
            </Tile>
          </div>
          <div className="min-w-0 min-h-0">
            <Tile label={unit.toUpperCase()}>
              <div className="text-app-instrument-secondary font-black leading-none">{Math.round(speed)}</div>
            </Tile>
          </div>
          <div className="min-w-0 min-h-0">
            <Tile label="LAP">
              <div className="text-app-instrument-secondary font-black leading-none tabular-nums">
                {lapNumber > 0 ? lapNumber : "-"}
                {totalLaps && totalLaps > 0 ? <span className="text-app-text/40">/{totalLaps}</span> : null}
              </div>
            </Tile>
          </div>
        </div>

        <div className="col-span-2 min-h-0 flex gap-3">
          <div className="flex-[3] min-w-0 min-h-0 rounded-md border border-app-text/10 bg-app-text/[0.02] overflow-hidden">
            {hasTelemetry ? (
              <FitToViewport padding={12} alignX="start" alignY="center">
                <div style={{ width: 560 }} className="space-y-3">
                  {!view && rawPacket ? <LapTimes packet={rawPacket} sectors={sectors} /> : null}
                  <SectorTimes sectors={sectors} />
                </div>
              </FitToViewport>
            ) : (
              <div className="h-full flex items-center justify-center text-app-text/40 text-sm tracking-widest uppercase">Waiting for lap data…</div>
            )}
          </div>
          <div className="flex-[2] min-w-0 min-h-0 rounded-md border border-app-text/10 bg-app-text/[0.02] overflow-hidden">
            {tires || rawPacket ? (
              <FitToViewport padding={4} maxScale={5}>
                <div style={{ width: 400 }} className="[&>div>:first-child]:hidden">
                  <TireGrid
                    fl={{ tempC: Math.round(tires?.temperatureC?.fl ?? (rawPacket ? toTempC(rawPacket.TireTempFL) : 0)), wear: tires?.wear?.fl ?? rawPacket?.TireWearFL ?? 0, brakeTemp: tires?.brakeTemperatureC?.fl ?? rawPacket?.BrakeTempFrontLeft ?? 0, pressure: tires?.pressurePsi?.fl ?? rawPacket?.TirePressureFrontLeft ?? 0 }}
                    fr={{ tempC: Math.round(tires?.temperatureC?.fr ?? (rawPacket ? toTempC(rawPacket.TireTempFR) : 0)), wear: tires?.wear?.fr ?? rawPacket?.TireWearFR ?? 0, brakeTemp: tires?.brakeTemperatureC?.fr ?? rawPacket?.BrakeTempFrontRight ?? 0, pressure: tires?.pressurePsi?.fr ?? rawPacket?.TirePressureFrontRight ?? 0 }}
                    rl={{ tempC: Math.round(tires?.temperatureC?.rl ?? (rawPacket ? toTempC(rawPacket.TireTempRL) : 0)), wear: tires?.wear?.rl ?? rawPacket?.TireWearRL ?? 0, brakeTemp: tires?.brakeTemperatureC?.rl ?? rawPacket?.BrakeTempRearLeft ?? 0, pressure: tires?.pressurePsi?.rl ?? rawPacket?.TirePressureRearLeft ?? 0 }}
                    rr={{ tempC: Math.round(tires?.temperatureC?.rr ?? (rawPacket ? toTempC(rawPacket.TireTempRR) : 0)), wear: tires?.wear?.rr ?? rawPacket?.TireWearRR ?? 0, brakeTemp: tires?.brakeTemperatureC?.rr ?? rawPacket?.BrakeTempRearRight ?? 0, pressure: tires?.pressurePsi?.rr ?? rawPacket?.TirePressureRearRight ?? 0 }}
                    healthThresholds={health} tempThresholds={{ blue: 60, orange: 85, red: 100 }}
                  />
                </div>
              </FitToViewport>
            ) : (
              <div className="h-full flex items-center justify-center text-app-text/40 text-sm tracking-widest uppercase">Waiting for tire data…</div>
            )}
          </div>
        </div>
      </div>
    </DashShell>
  );
}

function PitRow({ label, value, suffix, color }: { label: string; value: string; suffix: string; color: string }) {
  return (
    <div>
      <div className="text-app-text/40 text-xs tracking-widest uppercase">{label}</div>
      <div className={`text-app-instrument-value font-black leading-none tabular-nums ${color}`}>
        {value}
        <span className="text-app-text/40 text-base font-semibold ml-2">{suffix}</span>
      </div>
    </div>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative rounded-md border border-app-text/10 bg-app-text/[0.02] flex flex-col overflow-hidden min-w-0 min-h-0 h-full">
      <div className="shrink-0 text-app-text/40 text-xs tracking-widest uppercase px-3 pt-2">{label}</div>
      <div className="flex-1 min-h-0">
        <FitToViewport padding={6}>{children}</FitToViewport>
      </div>
    </div>
  );
}
