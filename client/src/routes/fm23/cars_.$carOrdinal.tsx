import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMemo, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CarWireframe } from "../../components/CarWireframe";
import { getCarModel, loadCarModelConfigs } from "../../data/car-models";
import type { TelemetryPacket } from "@shared/types";
import { client } from "../../lib/rpc";

function makeStaticPacket(carOrdinal: number): TelemetryPacket {
  return {
    IsRaceOn: 1,
    TimestampMS: 0,
    EngineMaxRpm: 8000,
    EngineIdleRpm: 800,
    CurrentEngineRpm: 800,
    Accel: 0,
    Brake: 0,
    Clutch: 0,
    HandBrake: 0,
    Gear: 0,
    Steer: 0,
    NormDrivingLine: 0,
    NormAIBrakeDiff: 0,
    VelocityX: 0,
    VelocityY: 0,
    VelocityZ: 0,
    AngularVelocityX: 0,
    AngularVelocityY: 0,
    AngularVelocityZ: 0,
    Yaw: 0,
    Pitch: 0,
    Roll: 0,
    NormSuspensionTravelFL: 0.5,
    NormSuspensionTravelFR: 0.5,
    NormSuspensionTravelRL: 0.5,
    NormSuspensionTravelRR: 0.5,
    TireSlipRatioFL: 0,
    TireSlipRatioFR: 0,
    TireSlipRatioRL: 0,
    TireSlipRatioRR: 0,
    WheelRotationSpeedFL: 0,
    WheelRotationSpeedFR: 0,
    WheelRotationSpeedRL: 0,
    WheelRotationSpeedRR: 0,
    WheelOnRumbleStripFL: 0,
    WheelOnRumbleStripFR: 0,
    WheelOnRumbleStripRL: 0,
    WheelOnRumbleStripRR: 0,
    WheelInPuddleDepthFL: 0,
    WheelInPuddleDepthFR: 0,
    WheelInPuddleDepthRL: 0,
    WheelInPuddleDepthRR: 0,
    SurfaceRumbleFL: 0,
    SurfaceRumbleFR: 0,
    SurfaceRumbleRL: 0,
    SurfaceRumbleRR: 0,
    TireSlipAngleFL: 0,
    TireSlipAngleFR: 0,
    TireSlipAngleRL: 0,
    TireSlipAngleRR: 0,
    TireCombinedSlipFL: 0,
    TireCombinedSlipFR: 0,
    TireCombinedSlipRL: 0,
    TireCombinedSlipRR: 0,
    SuspensionTravelMFL: 0,
    SuspensionTravelMFR: 0,
    SuspensionTravelMRL: 0,
    SuspensionTravelMRR: 0,
    CarOrdinal: carOrdinal,
    CarClass: 0,
    CarPerformanceIndex: 0,
    DrivetrainType: 0,
    NumCylinders: 0,
    PositionX: 0,
    PositionY: 0,
    PositionZ: 0,
    Speed: 0,
    Power: 0,
    Torque: 0,
    TireTempFL: 0,
    TireTempFR: 0,
    TireTempRL: 0,
    TireTempRR: 0,
    Boost: 0,
    Fuel: 1,
    DistanceTraveled: 0,
    BestLap: 0,
    LastLap: 0,
    CurrentLap: 0,
    CurrentRaceTime: 0,
    LapNumber: 0,
    RacePosition: 0,
    TireWearFL: 0,
    TireWearFR: 0,
    TireWearRL: 0,
    TireWearRR: 0,
    TrackOrdinal: 0,
  } as TelemetryPacket;
}

function CarModelPage() {
  const { carOrdinal } = Route.useParams();
  const ordinal = parseInt(carOrdinal, 10);
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  useEffect(() => {
    loadCarModelConfigs().then(() => setReady(true));
  }, []);
  const carModel = useMemo(() => (ready ? getCarModel(ordinal) : null), [ordinal, ready]);

  const { data: carInfo } = useQuery({
    queryKey: ["car", ordinal],
    queryFn: () => client.api.cars[":ordinal"].$get({ param: { ordinal: String(ordinal) } }).then((r) => (r.ok ? r.json() : null)),
  });

  const staticPacket = useMemo(() => makeStaticPacket(ordinal), [ordinal]);
  const telemetry = useMemo(() => [staticPacket], [staticPacket]);

  if (!carModel) return <div className="flex items-center justify-center h-full text-app-text-dim">Loading...</div>;

  if (!carModel.hasModel) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-app-text-dim">
        <div className="text-lg">No 3D model available for this car</div>
        <button onClick={() => navigate({ to: "/fm23/cars" })} className="px-4 py-2 rounded bg-app-surface-alt border border-app-border-input text-app-text-secondary hover:text-app-text">
          Back to Cars
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 p-3 border-b border-app-border shrink-0">
        <button
          onClick={() => navigate({ to: "/fm23/cars" })}
          className="text-app-label text-app-text-secondary hover:text-app-text px-2 py-1 rounded bg-app-surface-alt hover:bg-app-border-input transition-colors"
        >
          &larr; Cars
        </button>
        <div>
          <div className="text-app-heading font-semibold text-app-text">{carInfo?.name ?? `Car ${ordinal}`}</div>
          <div className="text-app-label text-app-text-muted">
            3D Model &middot; Ordinal {ordinal}
            {carModel.bodyLength && ` \u00b7 ${carModel.bodyLength}m`}
            {` \u00b7 Track: ${(carModel.halfFrontTrack * 2 * 1000).toFixed(0)}/${(carModel.halfRearTrack * 2 * 1000).toFixed(0)}mm`}
            {` \u00b7 Wheelbase: ${(carModel.halfWheelbase * 2 * 1000).toFixed(0)}mm`}
          </div>
        </div>
      </div>
      <div className="flex-1 min-h-0">
        <CarWireframe packet={staticPacket} telemetry={telemetry} cursorIdx={0} outline={null} carOrdinal={ordinal} minimal />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/fm23/cars_/$carOrdinal")({
  component: CarModelPage,
});
