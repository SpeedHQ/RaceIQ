import { createFileRoute } from "@tanstack/react-router";
import { LapComparison } from "../components/LapComparison";

function ComparePage() {
  return (
    <div className="flex-1 overflow-hidden">
      <LapComparison />
    </div>
  );
}

export const Route = createFileRoute("/compare")({
  component: ComparePage,
});
