import type { DisplayPacket } from "../../lib/convert-packet";
import { DashShell } from "./dash-shell";

interface SpeedDashProps {
  packet: DisplayPacket | null;
  unitSystem: "metric" | "imperial";
}

export function SpeedDash({ packet, unitSystem }: SpeedDashProps) {
  const speed = packet?.DisplaySpeed ?? 0;
  const unit = unitSystem === "metric" ? "km/h" : "mph";

  return (
    <DashShell>
      <div className="h-full w-full flex flex-col items-center justify-center">
        <div
          className="font-black leading-none text-white"
          style={{ fontSize: "clamp(8rem, 55vh, 32rem)" }}
        >
          {Math.round(speed)}
        </div>
        <div
          className="mt-4 font-semibold tracking-widest text-white/60 uppercase"
          style={{ fontSize: "clamp(1.5rem, 6vh, 3rem)" }}
        >
          {unit}
        </div>
      </div>
    </DashShell>
  );
}
