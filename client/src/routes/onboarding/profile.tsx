import { createFileRoute } from "@tanstack/react-router";
import { StepProfile } from "../../components/Onboarding";

export const Route = createFileRoute("/onboarding/profile")({
  component: StepProfile,
});
