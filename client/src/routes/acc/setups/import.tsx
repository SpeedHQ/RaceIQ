import { createFileRoute } from "@tanstack/react-router";
import { ImportSetupFile } from "../../../components/setup-tune/ImportSetupFile";

function ImportAccSetupPage() {
  return (
    <div className="flex-1 overflow-auto">
      <ImportSetupFile gameId="acc" routePrefix="/acc" gameLabel="ACC" />
    </div>
  );
}

export const Route = createFileRoute("/acc/setups/import")({
  component: ImportAccSetupPage,
});
