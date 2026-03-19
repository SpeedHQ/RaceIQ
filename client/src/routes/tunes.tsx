import { createFileRoute } from "@tanstack/react-router";
import { TuneCatalog } from "../components/TuneCatalog";

function TunesPage() {
  return (
    <div className="flex-1 overflow-auto">
      <TuneCatalog />
    </div>
  );
}

export const Route = createFileRoute("/tunes")({
  component: TunesPage,
});
