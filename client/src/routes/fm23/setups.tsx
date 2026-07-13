import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";

const SUB_TABS = [
  { to: "/fm23/setups", label: "Car Tunes", match: (p: string) => !p.startsWith("/fm23/setups/wheel") },
  { to: "/fm23/setups/wheel", label: "Wheel / FFB", match: (p: string) => p.startsWith("/fm23/setups/wheel") },
] as const;

function Fm23SetupsLayout() {
  const { pathname } = useLocation();
  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex gap-2 px-4 pt-3">
        {SUB_TABS.map((tab) => {
          const active = tab.match(pathname);
          return (
            <Link
              key={tab.to}
              to={tab.to}
              className={`text-app-label font-semibold uppercase px-3 py-1.5 rounded-lg transition-colors ${
                active
                  ? "bg-app-accent/20 text-app-accent ring-1 ring-app-accent/30"
                  : "bg-app-surface/40 text-app-text-muted hover:text-app-text-secondary ring-1 ring-app-border"
              }`}
            >
              {tab.label}
            </Link>
          );
        })}
      </div>
      <Outlet />
    </div>
  );
}

export const Route = createFileRoute("/fm23/setups")({
  component: Fm23SetupsLayout,
});
