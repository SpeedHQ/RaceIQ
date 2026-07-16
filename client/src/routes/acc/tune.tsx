import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for the Setup Engineer tune area. `/acc/tune` shows the tuning-session
 *  list (tune.index); `/acc/tune/$tuningSessionId` opens a session workspace. */
export const Route = createFileRoute("/acc/tune")({
  component: () => <Outlet />,
});
