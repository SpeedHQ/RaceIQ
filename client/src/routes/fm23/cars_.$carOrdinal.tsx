import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { m } from "@/paraglide/messages";
import type { SemanticAnalysisFrame } from "@/components/track-map/types";
import { CarWireframe } from "../../components/CarWireframe";
import { Button } from "../../components/ui/button";
import { getCarModel, loadCarModelConfigs } from "../../data/car-models";
import { client } from "../../lib/rpc";

function makeStaticFrame(carOrdinal: number): SemanticAnalysisFrame {
  return { values: {
    "identity.car-ordinal": carOrdinal, "identity.car-class": 0, "identity.car-performance-index": 0,
    "motion.speed": 0, "motion.position-x": 0, "motion.position-z": 0, "motion.yaw": 0, "motion.pitch": 0, "motion.roll": 0,
    "inputs.accel": 0, "inputs.brake": 0, "inputs.steer": 0, "inputs.gear": 0,
    "engine.current-engine-rpm": 800, "engine.engine-idle-rpm": 800, "engine.engine-max-rpm": 8000, "fuel.fuel": 1,
    "tire.temperature.average": [0, 0, 0, 0], "suspension.norm-suspension-travel": [0.5, 0.5, 0.5, 0.5],
  }, states: {}, freshness: {} };
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
    queryFn: () => client.api.cars[":ordinal"].$get({ param: { ordinal: String(ordinal) } }, { headers: { "X-Game-Id": "fm-2023" } }).then((r) => (r.ok ? r.json() : null)),
  });

  const staticFrame = useMemo(() => makeStaticFrame(ordinal), [ordinal]);
  const telemetry = useMemo(() => [staticFrame], [staticFrame]);

  if (!carModel) return <div className="flex items-center justify-center h-full text-app-text-dim">{m.carmodel_loading()}</div>;

  if (!carModel.hasModel) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-4 text-app-text-dim">
        <div className="text-lg">{m.carmodel_no_model()}</div>
        <Button
          onClick={() => navigate({ to: "/$gameid/cars", params: { gameid: "fm23" } })}
          className="px-4 py-2 rounded bg-app-surface-alt border border-app-border-input text-app-text-secondary hover:text-app-text"
        >
          {m.carmodel_back_to_cars()}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center gap-3 p-3 border-b border-app-border shrink-0">
        <Button
          onClick={() => navigate({ to: "/$gameid/cars", params: { gameid: "fm23" } })}
          className="text-app-label text-app-text-secondary hover:text-app-text px-2 py-1 rounded bg-app-surface-alt hover:bg-app-surface-hover transition-colors"
        >
          &larr; Cars
        </Button>
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
        <CarWireframe frame={staticFrame} telemetry={telemetry} cursorIdx={0} outline={null} carOrdinal={ordinal} minimal />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/fm23/cars_/$carOrdinal")({
  component: CarModelPage,
});
