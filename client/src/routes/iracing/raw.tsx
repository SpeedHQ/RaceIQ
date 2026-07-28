import { createFileRoute } from "@tanstack/react-router";
import { RawTelemetry } from "../../components/RawTelemetry";
import { useTelemetryStore } from "../../stores/telemetry";

function RawPage() {
  const packet = useTelemetryStore((state) => state.packet);
  return (
    <div className="flex-1 overflow-hidden">
      <RawTelemetry packet={packet} />
    </div>
  );
}

export const Route = createFileRoute("/iracing/raw")({
  component: RawPage,
});
