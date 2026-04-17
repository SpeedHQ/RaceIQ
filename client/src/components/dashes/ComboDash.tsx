import { useTelemetryStore } from "../../stores/telemetry";
import { formatLapTime } from "../../lib/format";
import { DashShell } from "./dash-shell";

function gearLabel(gear: number): string {
  if (gear <= 0) return "R";
  if (gear === 1) return "N";
  return String(gear - 1);
}

function zoneColor(pct: number): string {
  if (pct >= 0.98) return "#ff2d2d";
  if (pct >= 0.9) return "#ff6a00";
  if (pct >= 0.75) return "#ffd400";
  return "#22d172";
}

export function ComboDash() {
  const packet = useTelemetryStore((s) => s.packet);
  const unitSystem = useTelemetryStore((s) => s.unitSystem);

  const rpm = packet?.CurrentEngineRpm ?? 0;
  const idle = packet?.EngineIdleRpm ?? 0;
  const max = packet?.EngineMaxRpm ?? 10000;
  const gear = packet?.Gear ?? 1;
  const speed = packet?.DisplaySpeed ?? 0;
  const unit = unitSystem === "metric" ? "km/h" : "mph";
  const current = packet?.CurrentLap ?? 0;
  const last = packet?.LastLap ?? 0;
  const best = packet?.BestLap ?? 0;

  const span = Math.max(max - idle, 1);
  const pct = Math.max(0, Math.min(1, (rpm - idle) / span));
  const color = zoneColor(pct);
  const shiftNow = pct >= 0.98;

  const hasBest = best > 0;
  const hasLast = last > 0;
  const delta = hasBest && hasLast ? last - best : null;
  const deltaColor =
    delta === null ? "text-white/40" : delta < 0 ? "text-emerald-400" : "text-red-400";

  return (
    <DashShell>
      <div className="h-full w-full grid grid-cols-2 grid-rows-[auto_1fr_1fr] gap-3 p-4">
        <div
          className={`col-span-2 relative rounded-md overflow-hidden border border-white/10 ${
            shiftNow ? "animate-pulse" : ""
          }`}
          style={{ height: "10vh", minHeight: 50 }}
        >
          <div
            className="absolute inset-y-0 left-0 transition-[width] duration-75"
            style={{ width: `${pct * 100}%`, background: color }}
          />
          <div className="absolute right-2 top-1/2 -translate-y-1/2 text-white/90 font-mono text-sm tabular-nums">
            {Math.round(rpm).toLocaleString()} RPM
          </div>
        </div>

        <Tile label="GEAR">
          <div
            className="font-black leading-none"
            style={{ fontSize: "clamp(5rem, 22vh, 14rem)" }}
          >
            {gearLabel(gear)}
          </div>
        </Tile>

        <Tile label={unit.toUpperCase()}>
          <div
            className="font-black leading-none"
            style={{ fontSize: "clamp(4rem, 20vh, 12rem)" }}
          >
            {Math.round(speed)}
          </div>
        </Tile>

        <Tile label="CURRENT">
          <div
            className="font-black leading-none"
            style={{ fontSize: "clamp(2rem, 9vh, 5rem)" }}
          >
            {current > 0 ? formatLapTime(current) : "--:--.---"}
          </div>
          <div className="mt-2 text-white/60 text-sm tracking-widest">
            BEST {hasBest ? formatLapTime(best) : "--:--.---"}
          </div>
        </Tile>

        <Tile label="DELTA">
          <div
            className={`font-black leading-none ${deltaColor}`}
            style={{ fontSize: "clamp(2.5rem, 11vh, 6rem)" }}
          >
            {delta === null ? "--" : `${delta >= 0 ? "+" : "-"}${Math.abs(delta).toFixed(3)}`}
          </div>
          <div className="mt-2 text-white/60 text-sm tracking-widest">
            LAST {hasLast ? formatLapTime(last) : "--:--.---"}
          </div>
        </Tile>
      </div>
    </DashShell>
  );
}

function Tile({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative rounded-md border border-white/10 bg-white/[0.02] p-4 flex flex-col items-center justify-center overflow-hidden">
      <div className="absolute top-2 left-3 text-white/40 text-xs tracking-widest uppercase">
        {label}
      </div>
      <div className="flex-1 flex flex-col items-center justify-center">{children}</div>
    </div>
  );
}
