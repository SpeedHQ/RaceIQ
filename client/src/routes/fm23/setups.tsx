import { createFileRoute, Link, Outlet, useLocation } from "@tanstack/react-router";
import { m } from "@/paraglide/messages";

function Fm23SetupsLayout() {
  const { pathname } = useLocation();
  const SUB_TABS = [
    { to: "/fm23/setups", label: m.cardetail_section_car_tunes(), match: (p: string) => !p.startsWith("/fm23/setups/wheel") },
    { to: "/fm23/setups/wheel", label: m.cardetail_section_wheel_ffb(), match: (p: string) => p.startsWith("/fm23/setups/wheel") },
  ] as const;
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
                active ? "bg-app-accent/20 text-app-accent ring-1 ring-app-accent/30" : "bg-app-surface/40 text-app-text-muted hover:text-app-text-secondary ring-1 ring-app-border"
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
