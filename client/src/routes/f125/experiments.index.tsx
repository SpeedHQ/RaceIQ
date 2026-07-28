import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ExperimentList } from "../../components/tunes/ExperimentList";

/** `/f125/experiments` — the experiment list. Opening one routes to the workspace
 *  at `/f125/experiments/$experimentId` (path param, not a search param). */
export const Route = createFileRoute("/f125/experiments/")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  return <ExperimentList gameId="f1-2025" onOpen={(id) => navigate({ to: "/f125/experiments/$experimentId", params: { experimentId: String(id) } })} />;
}
