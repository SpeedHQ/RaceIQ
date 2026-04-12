import { createFileRoute } from "@tanstack/react-router";
import { AccLiveDashboard } from "../../components/acc/AccLiveDashboard";

export const Route = createFileRoute("/ac-evo/live")({
  component: () => <AccLiveDashboard gameId="ac-evo" />,
});
