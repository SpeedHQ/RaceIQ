import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/$gameid/sessions")({
  component: () => <Outlet />,
});
