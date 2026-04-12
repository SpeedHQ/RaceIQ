import { createFileRoute } from "@tanstack/react-router";
import { SessionsPage } from "../../components/SessionsPage";

export const Route = createFileRoute("/ac-evo/sessions")({
  component: SessionsPage,
});
