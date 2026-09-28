import { createFileRoute } from "@tanstack/react-router";
import { E2EViewer } from "../../components/settings/E2EViewer";

function DevE2EPage() {
  return (
    <div className="h-full overflow-y-auto p-6">
      <E2EViewer />
    </div>
  );
}

export const Route = createFileRoute("/dev/e2e")({
  component: DevE2EPage,
});
