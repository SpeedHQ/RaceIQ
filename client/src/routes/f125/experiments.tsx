import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for the Setup Engineer tune area. `/f125/experiments` shows the experiment
 *  list (tune.index); `/f125/experiments/$experimentId` opens a session workspace. */
export const Route = createFileRoute("/f125/experiments")({
  component: () => <Outlet />,
});
