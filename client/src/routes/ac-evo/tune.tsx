import { createFileRoute } from "@tanstack/react-router";
import { TuneDashboard } from "../../components/tunes/TuneDashboard";

export const Route = createFileRoute("/ac-evo/tune")({
  component: () => <TuneDashboard gameId="ac-evo" />,
});
