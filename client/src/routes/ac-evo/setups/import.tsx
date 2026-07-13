import { createFileRoute } from "@tanstack/react-router";
import { ImportSetupFile } from "../../../components/setup-tune/ImportSetupFile";
import { useAcEvoCars } from "../../../components/setup-tune/use-game-cars";

function ImportAcEvoSetupPage() {
  const { data: cars = [] } = useAcEvoCars();
  return (
    <div className="flex-1 overflow-auto">
      <ImportSetupFile
        gameId="ac-evo"
        routePrefix="/ac-evo"
        gameLabel="AC EVO"
        cars={cars}
      />
    </div>
  );
}

export const Route = createFileRoute("/ac-evo/setups/import")({
  component: ImportAcEvoSetupPage,
});
