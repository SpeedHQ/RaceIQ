import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/dev/speech")({
  beforeLoad: ({ location }) => {
    if (location.pathname === "/dev/speech") {
      throw redirect({ to: "/dev/speech/spotter", replace: true });
    }
  },
  component: () => <Outlet />,
});
