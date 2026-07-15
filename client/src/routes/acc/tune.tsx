import { createFileRoute } from "@tanstack/react-router";
import { TuneDashboard } from "../../components/tunes/TuneDashboard";

export const Route = createFileRoute("/acc/tune")({
  component: () => <TuneDashboard gameId="acc" />,
});
