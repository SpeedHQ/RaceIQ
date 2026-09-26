import { createFileRoute } from "@tanstack/react-router";
import { ImportSetupFile } from "../../../components/setup-tune/ImportSetupFile";

function ImportAcEvoSetupPage() {
  return (
    <div className="flex-1 overflow-auto">
      <ImportSetupFile gameId="ac-evo" routePrefix="/ac-evo" gameLabel="AC EVO" />
    </div>
  );
}

export const Route = createFileRoute("/ac-evo/setups/import")({
  component: ImportAcEvoSetupPage,
});
