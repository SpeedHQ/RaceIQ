import { createFileRoute } from "@tanstack/react-router";
import { DevStateViewer } from "../../components/DevStateViewer";

export const Route = createFileRoute("/dev/state")({
  component: DevStateViewer,
});
