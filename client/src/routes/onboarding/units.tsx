import { createFileRoute } from "@tanstack/react-router";
import { StepUnits } from "../../components/Onboarding";

export const Route = createFileRoute("/onboarding/units")({
  component: StepUnits,
});
