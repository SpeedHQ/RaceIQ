import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TuningSessionList } from "../../components/tunes/TuningSessionList";

/** `/f125/tune` — the tuning-session list. Opening one routes to the workspace
 *  at `/f125/tune/$tuningSessionId` (path param, not a search param). */
export const Route = createFileRoute("/f125/tune/")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  return <TuningSessionList gameId="f1-2025" onOpen={(id) => navigate({ to: "/f125/tune/$tuningSessionId", params: { tuningSessionId: String(id) } })} />;
}
