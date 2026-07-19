import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for the Setup Engineer tune area. `/f125/tune` shows the tuning-session
 *  list (tune.index); `/f125/tune/$tuningSessionId` opens a session workspace. */
export const Route = createFileRoute("/f125/tune")({
  component: () => <Outlet />,
});
