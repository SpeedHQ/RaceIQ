import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for the Setup Engineer tune area. `/acc/experiments` shows the experiment
 *  list (tune.index); `/acc/experiments/$experimentId` opens a session workspace. */
export const Route = createFileRoute("/acc/experiments")({
  component: () => <Outlet />,
});
