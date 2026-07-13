import { AccSetupBrowser } from "@/components/acc/AccSetupBrowser";
import { createFileRoute } from "@tanstack/react-router";

function AccSetupsPage() {
  return (
    <div className="flex-1 overflow-auto">
      <AccSetupBrowser />
    </div>
  );
}

export const Route = createFileRoute("/acc/setups/")({
  component: AccSetupsPage,
});
