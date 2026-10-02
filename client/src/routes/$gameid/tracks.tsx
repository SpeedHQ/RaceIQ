import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/$gameid/tracks")({
  component: () => (
    <div className="h-full min-h-0 min-w-0 overflow-auto">
      <Outlet />
    </div>
  ),
});
