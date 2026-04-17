import { useTelemetryStore } from "../../stores/telemetry";
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

export function RevDash() {
  const packet = useTelemetryStore((s) => s.packet);

  const rpm = packet?.CurrentEngineRpm ?? 0;
  const idle = packet?.EngineIdleRpm ?? 0;
  const max = packet?.EngineMaxRpm ?? 10000;
  const gear = packet?.Gear ?? 1;

  const span = Math.max(max - idle, 1);
  const rawPct = (rpm - idle) / span;
  const pct = Math.max(0, Math.min(1, rawPct));
  const color = zoneColor(pct);
  const shiftNow = pct >= 0.98;

  const ticks: number[] = [];
  for (let r = Math.ceil(idle / 1000) * 1000; r <= max; r += 1000) {
    ticks.push(r);
  }

  return (
    <DashShell>
      <div className="h-full w-full flex flex-col items-center justify-center gap-6 px-6">
        <div
          className={`relative w-full rounded-lg overflow-hidden border border-white/10 ${
            shiftNow ? "animate-pulse" : ""
          }`}
          style={{ height: "18vh", minHeight: 80, maxHeight: 160 }}
        >
          <div
            className="absolute inset-y-0 left-0 transition-[width] duration-75"
            style={{ width: `${pct * 100}%`, background: color }}
          />
          <div className="absolute inset-0 flex items-end justify-between px-2 pb-1 pointer-events-none">
            {ticks.map((t) => {
              const tickPct = (t - idle) / span;
              return (
                <div
                  key={t}
                  className="absolute bottom-0 h-3 w-px bg-white/40"
                  style={{ left: `${tickPct * 100}%` }}
                />
              );
            })}
          </div>
        </div>

        <div className="flex items-baseline gap-4">
          <div
            className="font-black leading-none"
            style={{ fontSize: "clamp(6rem, 35vh, 18rem)" }}
          >
            {gearLabel(gear)}
          </div>
        </div>

        <div
          className="font-semibold tracking-widest text-white/80"
          style={{ fontSize: "clamp(1.5rem, 6vh, 3rem)" }}
        >
          {Math.round(rpm).toLocaleString()} <span className="text-white/40 text-xl">RPM</span>
        </div>
      </div>
    </DashShell>
  );
}
