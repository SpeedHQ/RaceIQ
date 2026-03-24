import { createFileRoute } from "@tanstack/react-router";
import { StepConnection } from "../../components/Onboarding";

export const Route = createFileRoute("/onboarding/connection")({
  component: StepConnection,
});
