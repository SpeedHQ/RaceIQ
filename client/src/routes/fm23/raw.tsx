import { createFileRoute } from "@tanstack/react-router";
import { RawTelemetry } from "../../components/RawTelemetry";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";
import { useTelemetryStore } from "../../stores/telemetry";

function RawPage() {
  const devState = useTelemetryStore((s) => s.devState);
  const packet = (devState as { packet?: TelemetryPacket } | null)?.packet ?? null;
  return (
    <div className="flex-1 overflow-hidden">
      <RawTelemetry packet={packet} />
    </div>
  );
}

export const Route = createFileRoute("/fm23/raw")({
  component: RawPage,
});
