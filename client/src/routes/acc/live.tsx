import { createFileRoute } from "@tanstack/react-router";
import { AccLiveDashboard } from "../../components/acc/AccLiveDashboard";

export const Route = createFileRoute("/acc/live")({
  component: AccLiveDashboard,
});
