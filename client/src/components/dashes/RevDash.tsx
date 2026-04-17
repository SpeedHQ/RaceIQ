import { useTelemetryStore } from "../../stores/telemetry";
import { DashShell } from "./dash-shell";
import { RevBar } from "./RevBar";

function gearLabel(gear: number): string {
  if (gear <= 0) return "R";
  if (gear === 1) return "N";
  return String(gear - 1);
}

export function RevDash() {
  const packet = useTelemetryStore((s) => s.packet);

  const rpm = packet?.CurrentEngineRpm ?? 0;
  const idle = packet?.EngineIdleRpm ?? 0;
  const max = packet?.EngineMaxRpm ?? 10000;
  const gear = packet?.Gear ?? 1;

  return (
    <DashShell>
      <div className="h-full w-full flex flex-col items-center justify-center gap-6 px-6">
        <div style={{ height: "16vh", minHeight: 70, maxHeight: 140 }} className="w-full">
          <RevBar rpm={rpm} idle={idle} max={max} />
        </div>

        <div
          className="font-black leading-none"
          style={{ fontSize: "clamp(6rem, 35vh, 18rem)" }}
        >
          {gearLabel(gear)}
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
