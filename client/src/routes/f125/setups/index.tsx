import { createFileRoute } from "@tanstack/react-router";

function F125SetupPage() {
  return (
    <div className="flex items-center justify-center h-full text-app-text-dim">
      <div className="text-center space-y-2">
        <div className="text-lg font-semibold">F1 2025 Setup</div>
        <div className="text-sm">Coming soon</div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/f125/setups/")({
  component: F125SetupPage,
});
