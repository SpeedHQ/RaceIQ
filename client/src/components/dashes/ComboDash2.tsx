import { useTelemetryStore } from "../../stores/telemetry";
import { LapTimeChart } from "../LapTimeChart";
import { RecordedLaps } from "../RecordedLaps";
import { DashShell } from "./dash-shell";

export function ComboDash2() {
  const rawPacket = useTelemetryStore((s) => s.rawPacket);
  const trackOrdinal = rawPacket?.TrackOrdinal;

  return (
    <DashShell>
      <div className="h-full w-full grid grid-rows-[1fr_1fr] gap-3 p-4">
        <div className="min-w-0 min-h-0 rounded-md border border-white/10 bg-white/[0.02] overflow-hidden [&_div:has(>h2)]:hidden [&_button]:hidden">
          <LapTimeChart packet={rawPacket} />
        </div>

        <div className="min-w-0 min-h-0 rounded-md border border-white/10 bg-white/[0.02] overflow-hidden [&_div:has(>h2)]:hidden [&_button]:hidden [&_div.w-16]:hidden">
          {trackOrdinal ? (
            <div className="h-full overflow-y-auto">
              <RecordedLaps trackOrdinal={trackOrdinal} maxLaps={20} />
            </div>
          ) : (
            <div className="h-full flex items-center justify-center text-white/40 text-sm tracking-widest uppercase">
              Waiting for track…
            </div>
          )}
        </div>
      </div>
    </DashShell>
  );
}
