import { createFileRoute } from "@tanstack/react-router";
import { IRatingTracker } from "@/components/iracing/IRatingTracker";

export const Route = createFileRoute("/iracing/rating")({
  component: IRatingTracker,
});
