import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/acc/setups")({
  component: () => <Outlet />,
});
