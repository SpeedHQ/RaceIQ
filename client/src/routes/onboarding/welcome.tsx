import { createFileRoute } from "@tanstack/react-router";
import { StepWelcome } from "../../components/Onboarding";

export const Route = createFileRoute("/onboarding/welcome")({
  component: StepWelcome,
});
