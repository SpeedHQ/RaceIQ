import { createFileRoute, Outlet } from "@tanstack/react-router";

/** Layout for the Setup Engineer tune area. `/acc/tuning` shows the tuning-session
 *  list (tune.index); `/acc/tuning/$tuningSessionId` opens a session workspace. */
export const Route = createFileRoute("/acc/tuning")({
  component: () => <Outlet />,
});
