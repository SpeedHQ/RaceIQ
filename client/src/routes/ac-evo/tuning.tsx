import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for the Setup Engineer tune area. `/ac-evo/tuning` shows the tuning-
 *  session list; `/ac-evo/tuning/$tuningSessionId` opens a session workspace. */
export const Route = createFileRoute("/ac-evo/tuning")({
  component: () => <Outlet />,
});
