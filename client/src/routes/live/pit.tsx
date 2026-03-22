import { createFileRoute } from "@tanstack/react-router";
import { LivePage } from "../../components/LivePage";

export const Route = createFileRoute("/live/pit")({
  component: () => <LivePage mode="pitcrew" />,
});
