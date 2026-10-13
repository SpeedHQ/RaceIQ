import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/iracing")({
  component: Outlet,
});
