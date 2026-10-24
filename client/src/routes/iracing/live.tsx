import { createFileRoute } from "@tanstack/react-router";
import { IRacingLiveDashboard } from "@/components/iracing/IRacingLiveDashboard";

export const Route = createFileRoute("/iracing/live")({
  component: IRacingLiveDashboard,
});
