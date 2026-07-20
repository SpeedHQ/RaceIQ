import { createFileRoute, Navigate, Outlet, useLocation } from "@tanstack/react-router";

function Fm23LiveLayout() {
  const location = useLocation();
  if (location.pathname === "/fm23/live") {
    return <Navigate to="/fm23/live/driver" />;
  }
  return <Outlet />;
}

export const Route = createFileRoute("/fm23/live")({
  component: Fm23LiveLayout,
});
