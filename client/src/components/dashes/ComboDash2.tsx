import type { TelemetryPacket, LapMeta } from "@shared/types";
import { LapTimeChart } from "../LapTimeChart";
import { RecordedLaps } from "../RecordedLaps";
import { DashShell } from "./dash-shell";

interface ComboDash2Props {
  rawPacket: TelemetryPacket | null;
  allLaps: LapMeta[];
  sessionLaps: LapMeta[];
}

export function ComboDash2({ rawPacket, allLaps, sessionLaps }: ComboDash2Props) {
  const trackOrdinal = rawPacket?.TrackOrdinal;

  return (
    <DashShell>
      <div className="h-full w-full grid grid-rows-[3fr_2fr] gap-3 p-4">
        <div className="min-w-0 min-h-0 rounded-md border border-white/10 bg-white/[0.02] overflow-hidden [&_div:has(>h2)]:hidden [&_button]:hidden">
          <LapTimeChart packet={rawPacket} allLaps={allLaps} yTicks={2} />
        </div>

        <div className="min-w-0 min-h-0 rounded-md border border-white/10 bg-white/[0.02] overflow-hidden [&_div:has(>h2)]:hidden [&_button]:hidden [&_div.w-16]:hidden [&_.uppercase.tracking-wider]:hidden">
          {trackOrdinal ? (
            <div className="h-full overflow-hidden">
              <RecordedLaps laps={sessionLaps} trackOrdinal={trackOrdinal} maxLaps={30} />
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
