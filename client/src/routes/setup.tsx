import { createFileRoute } from "@tanstack/react-router";
import { HardwareSetup } from "../components/HardwareSetup";

function SetupPage() {
  return (
    <div className="flex-1 overflow-auto">
      <HardwareSetup />
    </div>
  );
}

export const Route = createFileRoute("/setup")({
  component: SetupPage,
});
