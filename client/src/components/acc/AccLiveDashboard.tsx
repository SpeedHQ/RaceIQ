import { useTelemetryStore } from "../../stores/telemetry";
import { tryGetGame } from "@shared/games/registry";
import { TireGrid } from "../telemetry/TireGrid";
import { LapTimeChart } from "../LapTimeChart";
import { PitEstimate } from "../telemetry/PitEstimate";
import { RecordedLaps } from "../RecordedLaps";
import { NoDataView } from "../NoDataView";
import { useTrackName, useCarName } from "../../hooks/queries";
import { RaceInfo } from "../RaceInfo";

// ── Main Dashboard ────────────────────────────────────────────────────────────

export function AccLiveDashboard() {
  const packet = useTelemetryStore((s) => s.packet);
  const { data: trackName } = useTrackName(packet?.TrackOrdinal);
  const { data: carName } = useCarName(packet?.CarOrdinal);

  if (!packet || packet.gameId !== "acc") {
    return (
      <div className="flex-1 flex flex-col">
        <NoDataView />
      </div>
    );
  }

  return (
    <div className="flex-1 grid grid-cols-1 lg:grid-cols-2 gap-0 h-full">
      {/* Left column: Tires + Pit Window */}
      <div className="border-r border-app-border overflow-auto">
        {/* Tires */}
        <div className="border-b border-app-border">
          <TireGrid
            fl={{ tempC: packet.TireTempFL, wear: packet.TireWearFL, brakeTemp: packet.BrakeTempFrontLeft ?? 0, brakePadMm: packet.acc?.brakePadWear[0], pressure: packet.TirePressureFrontLeft ?? 0 }}
            fr={{ tempC: packet.TireTempFR, wear: packet.TireWearFR, brakeTemp: packet.BrakeTempFrontRight ?? 0, brakePadMm: packet.acc?.brakePadWear[1], pressure: packet.TirePressureFrontRight ?? 0 }}
            rl={{ tempC: packet.TireTempRL, wear: packet.TireWearRL, brakeTemp: packet.BrakeTempRearLeft ?? 0, brakePadMm: packet.acc?.brakePadWear[2], pressure: packet.TirePressureRearLeft ?? 0 }}
            rr={{ tempC: packet.TireTempRR, wear: packet.TireWearRR, brakeTemp: packet.BrakeTempRearRight ?? 0, brakePadMm: packet.acc?.brakePadWear[3], pressure: packet.TirePressureRearRight ?? 0 }}
            healthThresholds={tryGetGame("acc")?.tireHealthThresholds ?? { green: 0.85, yellow: 0.70 }}
            tempThresholds={{ blue: 70, orange: 100, red: 110 }}
            pressureOptimal={tryGetGame("acc")?.tirePressureOptimal}
            brakeTempThresholds={tryGetGame("acc")?.brakeTempThresholds}
            compound={packet.acc?.tireCompound}
          />
        </div>

        {/* Pit Window */}
        <div className="border-b border-app-border">
          <div className="p-2 border-b border-app-border">
            <h2 className="text-xs font-semibold text-app-text-muted uppercase tracking-wider">Pit Window</h2>
          </div>
          <div className="p-3">
            <PitEstimate packet={packet} />
          </div>
        </div>
      </div>

      {/* Right column: Race (with sectors) + Charts + Recorded Laps */}
      <div className="overflow-auto flex flex-col">
        <RaceInfo packet={packet} trackName={trackName} carName={carName} showTrackMap={false} showSectors={true} />

        <LapTimeChart packet={packet} />

        <div className="flex-1">
          <RecordedLaps />
        </div>
      </div>
    </div>
  );
}
