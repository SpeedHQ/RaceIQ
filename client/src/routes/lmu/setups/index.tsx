import { createFileRoute } from "@tanstack/react-router";
import { LmuSetupWorkspace } from "@/components/lmu/setups/LmuSetupWorkspace";

function LmuSetupsPage() {
  return (
    <div className="flex-1 overflow-auto">
      <LmuSetupWorkspace />
    </div>
  );
}

export const Route = createFileRoute("/lmu/setups/")({
  component: LmuSetupsPage,
});
