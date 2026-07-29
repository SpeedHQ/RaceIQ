import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/iracing/tracks")({
  component: () => (
    <div className="flex-1 overflow-auto">
      <Outlet />
    </div>
  ),
});
