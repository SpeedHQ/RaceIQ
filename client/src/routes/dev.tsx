import { createFileRoute } from "@tanstack/react-router";
import { DevStateViewer } from "../components/DevStateViewer";

function DevPage() {
  return (
    <div className="flex-1 overflow-hidden h-full">
      <DevStateViewer />
    </div>
  );
}

export const Route = createFileRoute("/dev")({
  component: DevPage,
});
