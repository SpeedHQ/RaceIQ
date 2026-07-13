import { F125SetupBrowser } from "@/components/f1/F125SetupBrowser";
import { createFileRoute } from "@tanstack/react-router";

function F125SetupsPage() {
  return (
    <div className="flex-1 overflow-auto">
      <F125SetupBrowser />
    </div>
  );
}

export const Route = createFileRoute("/f125/setups/")({
  component: F125SetupsPage,
});
