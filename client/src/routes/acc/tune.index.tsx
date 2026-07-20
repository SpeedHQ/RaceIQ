import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TuningSessionList } from "../../components/tunes/TuningSessionList";

/** `/acc/tune` — the tuning-session list. Opening one routes to the workspace
 *  at `/acc/tune/$tuningSessionId` (path param, not a search param). */
export const Route = createFileRoute("/acc/tune/")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  return <TuningSessionList gameId="acc" onOpen={(id) => navigate({ to: "/acc/tune/$tuningSessionId", params: { tuningSessionId: String(id) } })} />;
}
