import { createFileRoute } from "@tanstack/react-router";
import { StepWheel } from "../../components/Onboarding";

export const Route = createFileRoute("/onboarding/wheel")({
  component: StepWheel,
});
