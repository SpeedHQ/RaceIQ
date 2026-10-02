import { createFileRoute } from "@tanstack/react-router";
import { AccSetupBrowser } from "@/components/acc/AccSetupBrowser";

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
