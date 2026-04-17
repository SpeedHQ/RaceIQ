import { useTelemetryStore } from "../../stores/telemetry";
import { useGameId } from "../../stores/game";
import { useUnits } from "../../hooks/useUnits";
import { tryGetGame } from "@shared/games/registry";
import { LapTimes } from "../telemetry/LapTimes";
import { SectorTimes } from "../SectorTimes";
import { TireGrid } from "../telemetry/TireGrid";
import { DashShell } from "./dash-shell";
import { FitToViewport } from "./FitToViewport";
import { RevBar } from "./RevBar";

function gearLabel(gear: number): string {
  if (gear <= 0) return "R";
  if (gear === 1) return "N";
  return String(gear - 1);
}

export function ComboDash() {
  const rawPacket = useTelemetryStore((s) => s.rawPacket);
  const packet = useTelemetryStore((s) => s.packet);
  const sectors = useTelemetryStore((s) => s.sectors);
  const unitSystem = useTelemetryStore((s) => s.unitSystem);
  const gameId = useGameId();
  const units = useUnits();
  const game = gameId ? tryGetGame(gameId) : null;

  const rpm = packet?.CurrentEngineRpm ?? 0;
  const idle = packet?.EngineIdleRpm ?? 0;
  const max = packet?.EngineMaxRpm ?? 10000;
  const gear = packet?.Gear ?? 1;
  const speed = packet?.DisplaySpeed ?? 0;
  const unit = unitSystem === "metric" ? "km/h" : "mph";
  const lapNumber = packet?.LapNumber ?? 0;
  const totalLaps = rawPacket?.f1?.totalLaps;

  return (
    <DashShell>
      <div className="h-full w-full grid grid-cols-2 grid-rows-[auto_minmax(0,auto)_1fr] gap-3 p-4">
        <div
          className="col-span-2 relative flex items-center gap-3"
          style={{ height: "10vh", minHeight: 50 }}
        >
          <div className="flex-1 h-full">
            <RevBar rpm={rpm} idle={idle} max={max} segments={80} />
          </div>
          <div className="text-white/90 font-mono text-sm tabular-nums whitespace-nowrap">
            {Math.round(rpm).toLocaleString()} RPM
          </div>
        </div>

        <div className="col-span-2 flex gap-3">
          <div className="w-1/4">
            <Tile label="GEAR">
              <div
                className="font-black leading-none"
                style={{ fontSize: "clamp(3rem, 14vh, 8rem)" }}
              >
                {gearLabel(gear)}
              </div>
            </Tile>
          </div>
          <div className="w-1/4">
            <Tile label={unit.toUpperCase()}>
              <div
                className="font-black leading-none"
                style={{ fontSize: "clamp(2.5rem, 13vh, 7rem)" }}
              >
                {Math.round(speed)}
              </div>
            </Tile>
          </div>
          <div className="w-1/4">
            <Tile label="LAP">
              <div
                className="font-black leading-none tabular-nums"
                style={{ fontSize: "clamp(2.5rem, 13vh, 7rem)" }}
              >
                {lapNumber > 0 ? lapNumber : "-"}
                {totalLaps && totalLaps > 0 ? (
                  <span className="text-white/40">/{totalLaps}</span>
                ) : null}
              </div>
            </Tile>
          </div>
        </div>

        <div className="col-span-2 min-h-0 flex gap-3">
          <div className="flex-[2] min-w-0 min-h-0 rounded-md border border-white/10 bg-white/[0.02] overflow-hidden">
            {rawPacket ? (
              <FitToViewport padding={12} alignX="start" alignY="start">
                <div style={{ width: 560 }} className="space-y-3">
                  <LapTimes packet={rawPacket} sectors={sectors} />
                  <SectorTimes />
                </div>
              </FitToViewport>
            ) : (
              <div className="h-full flex items-center justify-center text-white/40 text-sm tracking-widest uppercase">Waiting for lap data…</div>
            )}
          </div>

          <div className="flex-1 min-w-0 min-h-0 rounded-md border border-white/10 bg-white/[0.02] overflow-hidden">
            {rawPacket ? (
              <FitToViewport padding={12} maxScale={1.5}>
                <div style={{ width: 340 }} className="[&>div>:first-child]:hidden">
                  <TireGrid
                    fl={{
                      tempC: Math.round(units.toTempC(rawPacket.TireTempFL)),
                      wear: rawPacket.TireWearFL,
                      brakeTemp: rawPacket.BrakeTempFrontLeft ?? 0,
                      pressure: rawPacket.TirePressureFrontLeft ?? 0,
                    }}
                    fr={{
                      tempC: Math.round(units.toTempC(rawPacket.TireTempFR)),
                      wear: rawPacket.TireWearFR,
                      brakeTemp: rawPacket.BrakeTempFrontRight ?? 0,
                      pressure: rawPacket.TirePressureFrontRight ?? 0,
                    }}
                    rl={{
                      tempC: Math.round(units.toTempC(rawPacket.TireTempRL)),
                      wear: rawPacket.TireWearRL,
                      brakeTemp: rawPacket.BrakeTempRearLeft ?? 0,
                      pressure: rawPacket.TirePressureRearLeft ?? 0,
                    }}
                    rr={{
                      tempC: Math.round(units.toTempC(rawPacket.TireTempRR)),
                      wear: rawPacket.TireWearRR,
                      brakeTemp: rawPacket.BrakeTempRearRight ?? 0,
                      pressure: rawPacket.TirePressureRearRight ?? 0,
                    }}
                    healthThresholds={game?.tireHealthThresholds ?? { green: 0.7, yellow: 0.4 }}
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

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative rounded-md border border-white/10 bg-white/[0.02] flex flex-col overflow-hidden min-w-0 min-h-0">
      <div className="shrink-0 text-white/40 text-xs tracking-widest uppercase px-3 pt-2">
        {label}
      </div>
      <div className="flex-1 min-h-0">
        <FitToViewport padding={6}>{children}</FitToViewport>
      </div>
    </div>
  );
}
