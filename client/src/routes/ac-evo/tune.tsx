import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for the Setup Engineer tune area. `/ac-evo/tune` shows the tuning-
 *  session list; `/ac-evo/tune/$tuningSessionId` opens a session workspace. */
export const Route = createFileRoute("/ac-evo/tune")({
  component: () => <Outlet />,
});
