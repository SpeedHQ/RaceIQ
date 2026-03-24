import { createFileRoute } from "@tanstack/react-router";
import { StepSound } from "../../components/Onboarding";

export const Route = createFileRoute("/onboarding/sound")({
  component: StepSound,
});
