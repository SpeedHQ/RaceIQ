import type { LivePitData, LiveSectorData } from "../../../../shared/racing/live/types";
import type { LiveTelemetryView } from "../../lib/live-telemetry-view";
import { SectorTimes } from "../SectorTimes";
import { TireGrid } from "../telemetry/TireGrid";
import { DashShell } from "./dash-shell";
import { FitToViewport } from "./FitToViewport";
import { RevBar } from "./RevBar";
interface ComboDashProps {
  view?: LiveTelemetryView | null;
  sectors: LiveSectorData | null;
  pit: LivePitData | null;
  unitSystem: "metric" | "imperial";
  tireHealthThresholds?: { green: number; yellow: number };
}

function gearLabel(gear: number): string {
  if (gear <= 0) return "R";
  if (gear === 1) return "N";
  return String(gear - 1);
}
export function ComboDash({ view, sectors, pit, unitSystem, tireHealthThresholds }: ComboDashProps) {
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
  const rpm = view?.engine.rpm ?? 0;
  const idle = view?.engine.idleRpm ?? 0;
  const max = view?.engine.maxRpm ?? 10000;
  const gear = view?.inputs.gear ?? 1;
  const speed = (view?.motion.speedMps ?? 0) * (unitSystem === "metric" ? 3.6 : 2.23694);
  const unit = unitSystem === "metric" ? "km/h" : "mph";
  const lapNumber = view?.timing.lapNumber ?? 0;
  const totalLaps = view?.timing.totalLaps;
  const health = tireHealthThresholds ?? { green: 0.7, yellow: 0.4 };
  const tires = view?.tires;
  const temperatureAvailable = tires?.temperatureC !== undefined;
  const healthAvailable = tires?.wear !== undefined;
  const hasTelemetry = !!view;

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
                  <SectorTimes sectors={sectors} />
                </div>
              </FitToViewport>
            ) : (
              <div className="h-full flex items-center justify-center text-app-text/40 text-sm tracking-widest uppercase">Waiting for lap data…</div>
            )}
          </div>
          <div className="flex-[2] min-w-0 min-h-0 rounded-md border border-app-text/10 bg-app-text/[0.02] overflow-hidden">
            {tires ? (
              <FitToViewport padding={4} maxScale={5}>
                <div style={{ width: 400 }} className="[&>div>:first-child]:hidden">
                  <TireGrid
                    fl={{
                      tempC: Math.round(tires.temperatureC?.fl ?? 0),
                      wear: tires.wear?.fl ?? 0,
                      ...(tires.brakeTemperatureC ? { brakeTemp: tires.brakeTemperatureC.fl } : {}),
                      ...(tires.pressurePsi ? { pressure: tires.pressurePsi.fl } : {}),
                    }}
                    fr={{
                      tempC: Math.round(tires.temperatureC?.fr ?? 0),
                      wear: tires.wear?.fr ?? 0,
                      ...(tires.brakeTemperatureC ? { brakeTemp: tires.brakeTemperatureC.fr } : {}),
                      ...(tires.pressurePsi ? { pressure: tires.pressurePsi.fr } : {}),
                    }}
                    rl={{
                      tempC: Math.round(tires.temperatureC?.rl ?? 0),
                      wear: tires.wear?.rl ?? 0,
                      ...(tires.brakeTemperatureC ? { brakeTemp: tires.brakeTemperatureC.rl } : {}),
                      ...(tires.pressurePsi ? { pressure: tires.pressurePsi.rl } : {}),
                    }}
                    rr={{
                      tempC: Math.round(tires.temperatureC?.rr ?? 0),
                      wear: tires.wear?.rr ?? 0,
                      ...(tires.brakeTemperatureC ? { brakeTemp: tires.brakeTemperatureC.rr } : {}),
                      ...(tires.pressurePsi ? { pressure: tires.pressurePsi.rr } : {}),
                    }}
                    healthThresholds={health}
                    tempThresholds={{ blue: 60, orange: 85, red: 100 }}
                    temperatureAvailable={temperatureAvailable}
                    healthAvailable={healthAvailable}
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
