import { createFileRoute } from "@tanstack/react-router";
import { LiveDashboardPage } from "../components/LiveDashboardPage";

export const Route = createFileRoute("/live/pit")({ component: () => <LiveDashboardPage mode="pitcrew" /> });
