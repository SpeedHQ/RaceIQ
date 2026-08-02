import { createFileRoute, Outlet } from "@tanstack/react-router";

function Fm23SetupsLayout() {
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <Outlet />
    </div>
  );
}

export const Route = createFileRoute("/fm23/setups")({
  component: Fm23SetupsLayout,
});
