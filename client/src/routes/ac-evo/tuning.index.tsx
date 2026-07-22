import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TuningSessionList } from "../../components/tunes/TuningSessionList";

/** `/ac-evo/tuning` — the tuning-session list. Opening one routes to the workspace
 *  at `/ac-evo/tuning/$tuningSessionId` (path param, not a search param). */
export const Route = createFileRoute("/ac-evo/tuning/")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  return <TuningSessionList gameId="ac-evo" onOpen={(id) => navigate({ to: "/ac-evo/tuning/$tuningSessionId", params: { tuningSessionId: String(id) } })} />;
}
