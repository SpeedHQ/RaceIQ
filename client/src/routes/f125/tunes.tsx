import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/f125/tunes")({
  component: () => <Outlet />,
});
