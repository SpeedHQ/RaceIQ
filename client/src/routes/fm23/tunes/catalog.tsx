import { createFileRoute } from "@tanstack/react-router";
import { Fm23TuneBrowser } from "../../../components/tune/fm23/Fm23TuneBrowser";

export const Route = createFileRoute("/fm23/tunes/catalog")({
  component: () => (
    <div className="flex-1 overflow-auto">
      <Fm23TuneBrowser />
    </div>
  ),
});
