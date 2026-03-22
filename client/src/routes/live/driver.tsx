import { createFileRoute } from "@tanstack/react-router";
import { LivePage } from "../../components/LivePage";

export const Route = createFileRoute("/live/driver")({
  component: () => <LivePage mode="driver" />,
});
