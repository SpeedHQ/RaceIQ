import { createFileRoute } from "@tanstack/react-router";
import { ImportSetupFile } from "../../../components/setup-tune/ImportSetupFile";
import { useAccCars } from "../../../components/setup-tune/use-game-cars";

function ImportAccSetupPage() {
  const { data: cars = [] } = useAccCars();
  return (
    <div className="flex-1 overflow-auto">
      <ImportSetupFile
        gameId="acc"
        routePrefix="/acc"
        gameLabel="ACC"
        cars={cars}
      />
    </div>
  );
}

export const Route = createFileRoute("/acc/setups/import")({
  component: ImportAccSetupPage,
});
