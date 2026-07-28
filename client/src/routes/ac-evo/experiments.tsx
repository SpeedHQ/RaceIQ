import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for the Setup Engineer tune area. `/ac-evo/experiments` shows the tuning-
 *  session list; `/ac-evo/experiments/$experimentId` opens a session workspace. */
export const Route = createFileRoute("/ac-evo/experiments")({
  component: () => <Outlet />,
});
