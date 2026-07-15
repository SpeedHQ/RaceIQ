import { Outlet, createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/ac-evo/tracks")({
  component: () => (
    <div className="flex-1 overflow-auto">
      <Outlet />
    </div>
  ),
});
