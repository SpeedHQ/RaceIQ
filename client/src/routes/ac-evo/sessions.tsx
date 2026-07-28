import { createFileRoute } from "@tanstack/react-router";
import { SessionsPage, type SessionsTab } from "../../components/SessionsPage";

type SessionsSearch = { tab?: SessionsTab };

export const Route = createFileRoute("/ac-evo/sessions")({
  component: SessionsPage,
  validateSearch: (search: Record<string, unknown>): SessionsSearch => ({
    tab: search.tab === "imported" ? "imported" : undefined,
  }),
});
