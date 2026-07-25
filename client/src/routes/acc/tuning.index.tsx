import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TuningSessionList } from "../../components/tunes/TuningSessionList";

/** `/acc/tuning` — the tuning-session list. Opening one routes to the workspace
 *  at `/acc/tuning/$tuningSessionId` (path param, not a search param). */
export const Route = createFileRoute("/acc/tuning/")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  return <TuningSessionList gameId="acc" onOpen={(id) => navigate({ to: "/acc/tuning/$tuningSessionId", params: { tuningSessionId: String(id) } })} />;
}
