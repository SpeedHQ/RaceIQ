import { createFileRoute, Navigate, Outlet, useLocation } from "@tanstack/react-router";

function IRacingLiveLayout() {
  const location = useLocation();
  if (location.pathname === "/iracing/live") {
    return <Navigate to="/iracing/live/driver" />;
  }
  return <Outlet />;
}

export const Route = createFileRoute("/iracing/live")({
  component: IRacingLiveLayout,
});
