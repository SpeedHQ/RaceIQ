import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { TuningSessionList } from "../../components/tunes/TuningSessionList";

/** `/ac-evo/tune` — the tuning-session list. Opening one routes to the workspace
 *  at `/ac-evo/tune/$tuningSessionId` (path param, not a search param). */
export const Route = createFileRoute("/ac-evo/tune/")({
  component: RouteComponent,
});

function RouteComponent() {
  const navigate = useNavigate();
  return (
    <TuningSessionList
      gameId="ac-evo"
      onOpen={(id) => navigate({ to: "/ac-evo/tune/$tuningSessionId", params: { tuningSessionId: String(id) } })}
    />
  );
}
