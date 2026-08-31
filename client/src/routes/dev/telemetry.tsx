import { createFileRoute } from "@tanstack/react-router";
import { DevTelemetryPanel } from "../../components/dev/DevTelemetryPanel";

export const Route = createFileRoute("/dev/telemetry")({
  component: DevTelemetryPanel,
});
