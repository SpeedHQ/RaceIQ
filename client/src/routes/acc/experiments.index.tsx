import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ExperimentList } from "../../components/tunes/ExperimentList";

/** `/acc/experiments` — the experiment list. Opening one routes to the workspace
 *  at `/acc/experiments/$experimentId` (path param, not a search param). */
export const Route = createFileRoute("/acc/experiments/")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  return <ExperimentList gameId="acc" onOpen={(id) => navigate({ to: "/acc/experiments/$experimentId", params: { experimentId: String(id) } })} />;
}
