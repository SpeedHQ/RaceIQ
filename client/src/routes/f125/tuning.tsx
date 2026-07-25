import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for the Setup Engineer tune area. `/f125/tuning` shows the tuning-session
 *  list (tune.index); `/f125/tuning/$tuningSessionId` opens a session workspace. */
export const Route = createFileRoute("/f125/tuning")({
  component: () => <Outlet />,
});
