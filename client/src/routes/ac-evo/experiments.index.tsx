import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ExperimentList } from "../../components/tunes/ExperimentList";

/** `/ac-evo/experiments` — the experiment list. Opening one routes to the workspace
 *  at `/ac-evo/experiments/$experimentId` (path param, not a search param). */
export const Route = createFileRoute("/ac-evo/experiments/")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  return <ExperimentList gameId="ac-evo" onOpen={(id) => navigate({ to: "/ac-evo/experiments/$experimentId", params: { experimentId: String(id) } })} />;
}
