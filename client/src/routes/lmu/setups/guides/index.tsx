import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { LmuSetupGuide } from "@/components/lmu/setups/LmuSetupGuide";
import { m } from "@/paraglide/messages";

function LmuGuidePage() {
  const { parameter } = Route.useSearch();
  const navigate = useNavigate();
  return <main className="flex-1 overflow-auto">
    <div className="flex min-w-0 flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center gap-2">
        <h1 className="text-app-title">{m.lmu_guide_title()}</h1>
        <Link className="ml-auto text-app-compact text-app-accent hover:underline" to="/lmu/setups">{m.tab_setups()}</Link>
      </header>
      <LmuSetupGuide parameterId={parameter} onParameterChange={(id) => void navigate({ to: "/lmu/setups/guides", search: { parameter: id }, replace: true })} />
    </div>
  </main>;
}

export const Route = createFileRoute("/lmu/setups/guides/")({
  validateSearch: (search: Record<string, unknown>): { parameter?: string } => ({
    ...(typeof search.parameter === "string" ? { parameter: search.parameter } : {}),
  }),
  component: LmuGuidePage,
});
