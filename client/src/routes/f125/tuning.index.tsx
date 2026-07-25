import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TuningSessionList } from "../../components/tunes/TuningSessionList";

/** `/f125/tuning` — the tuning-session list. Opening one routes to the workspace
 *  at `/f125/tuning/$tuningSessionId` (path param, not a search param). */
export const Route = createFileRoute("/f125/tuning/")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  return <TuningSessionList gameId="f1-2025" onOpen={(id) => navigate({ to: "/f125/tuning/$tuningSessionId", params: { tuningSessionId: String(id) } })} />;
}
