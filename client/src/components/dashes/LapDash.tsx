import type { LiveSectorData } from "@shared/types";
import type { DisplayPacket } from "../../lib/convert-packet";
import { RaceInfo } from "../RaceInfo";
import { FitToViewport } from "./FitToViewport";

const BASE_WIDTH = 640;

interface LapDashProps {
  packet: DisplayPacket | null;
  sectors: LiveSectorData | null;
  carName?: string;
  trackName?: string;
}

export function LapDash({ packet, sectors, carName, trackName }: LapDashProps) {
  return (
    <div className="fixed inset-0 overflow-hidden bg-app-bg text-app-text">
      {packet ? (
        <FitToViewport>
          <div style={{ width: BASE_WIDTH }}>
            <RaceInfo
              packet={packet}
              sectors={sectors}
              carName={carName}
              trackName={trackName}
              showTrackMap={false}
              showSectors={true}
            />
          </div>
        </FitToViewport>
      ) : (
        <div className="h-full flex items-center justify-center text-app-text-muted text-sm tracking-widest uppercase">
          Waiting for telemetry…
        </div>
      )}
    </div>
  );
}
