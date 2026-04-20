import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/acc/tunes")({
  component: () => <Outlet />,
});
