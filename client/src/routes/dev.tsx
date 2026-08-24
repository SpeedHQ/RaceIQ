import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

function DevLayout() {
  return (
    <div className="h-full overflow-hidden bg-app-surface">
      <Outlet />
    </div>
  );
}

export const Route = createFileRoute("/dev")({
  beforeLoad: ({ location }) => {
    if (location.pathname === "/dev") {
      throw redirect({ to: "/dev/state", replace: true });
    }
  },
  component: DevLayout,
});
