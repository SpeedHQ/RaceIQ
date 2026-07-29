import { createFileRoute } from "@tanstack/react-router";
import { ForzaLiveDashboard } from "../../../components/ForzaLiveDashboard";

export const Route = createFileRoute("/iracing/live/driver")({
  component: () => <ForzaLiveDashboard mode="driver" />,
});
