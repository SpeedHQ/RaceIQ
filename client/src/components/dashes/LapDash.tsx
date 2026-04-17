import { useTelemetryStore } from "../../stores/telemetry";
import { RaceInfo } from "../RaceInfo";
import { useCarName, useTrackName } from "../../hooks/queries";
import { FitToViewport } from "./FitToViewport";

const BASE_WIDTH = 640;

export function LapDash() {
  const packet = useTelemetryStore((s) => s.packet);
  const serverStatus = useTelemetryStore((s) => s.serverStatus);

  const carOrdinal = serverStatus?.currentSession?.carOrdinal ?? packet?.CarOrdinal;
  const trackOrdinal = serverStatus?.currentSession?.trackOrdinal;
  const { data: carName } = useCarName(carOrdinal);
  const { data: trackName } = useTrackName(trackOrdinal);

  return (
    <div className="fixed inset-0 overflow-hidden bg-app-bg text-app-text">
      {packet ? (
        <FitToViewport>
          <div style={{ width: BASE_WIDTH }}>
            <RaceInfo
              packet={packet}
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
