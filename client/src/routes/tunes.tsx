import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/tunes")({
  component: () => <Outlet />,
});
