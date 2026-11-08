import { createFileRoute } from "@tanstack/react-router";
import { SessionsPage } from "@raceiq/sessions-page/ui";
import { validateSessionsSearch } from "@raceiq/sessions-page/contracts";

export const Route = createFileRoute("/$gameid/sessions/")({
  component: SessionsPage,
  validateSearch: validateSessionsSearch,
});
