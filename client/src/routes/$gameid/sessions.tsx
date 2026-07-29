import { createFileRoute } from "@tanstack/react-router";
import { SessionsPage } from "../../components/SessionsPage";
import { validateSessionsSearch } from "../../lib/game-routes";

export const Route = createFileRoute("/$gameid/sessions")({
  component: SessionsPage,
  validateSearch: validateSessionsSearch,
});
