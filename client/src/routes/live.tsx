import { createFileRoute } from "@tanstack/react-router";
import { LiveDashboardPage } from "../components/LiveDashboardPage";

export const Route = createFileRoute("/live")({ component: () => <LiveDashboardPage mode="driver" /> });
