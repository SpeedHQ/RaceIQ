import { createFileRoute } from "@tanstack/react-router";
import { RawTelemetry } from "../components/RawTelemetry";
import { useTelemetry } from "../context/telemetry";

function RawPage() {
  const { packet } = useTelemetry();
  return (
    <div className="flex-1 overflow-hidden">
      <RawTelemetry packet={packet} />
    </div>
  );
}

export const Route = createFileRoute("/raw")({
  component: RawPage,
});
