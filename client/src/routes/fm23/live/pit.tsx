import { createFileRoute } from "@tanstack/react-router";
import { ForzaLiveDashboard } from "../../../components/ForzaLiveDashboard";

export const Route = createFileRoute("/fm23/live/pit")({
  component: () => <ForzaLiveDashboard mode="pitcrew" />,
});
