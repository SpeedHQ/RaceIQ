import { createFileRoute } from "@tanstack/react-router";
import { LapAnalyse } from "../components/LapAnalyse";

function AnalysePage() {
  return (
    <div className="flex-1 overflow-hidden">
      <LapAnalyse />
    </div>
  );
}

export const Route = createFileRoute("/analyse")({
  component: AnalysePage,
});
