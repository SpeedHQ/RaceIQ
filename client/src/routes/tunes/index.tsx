import { createFileRoute } from "@tanstack/react-router";
import { TuneCatalog } from "../../components/TuneCatalog";

export const Route = createFileRoute("/tunes/")({
  component: () => (
    <div className="flex-1 overflow-auto">
      <TuneCatalog />
    </div>
  ),
});
