import { createFileRoute } from "@tanstack/react-router";
import { SetupTuneBrowser } from "../../../components/setup-tune/SetupTuneBrowser";
import { useAcEvoCars } from "../../../components/setup-tune/use-game-cars";

function AcEvoTunesPage() {
  const { data: cars = [] } = useAcEvoCars();
  return (
    <div className="flex-1 overflow-auto">
      <SetupTuneBrowser
        gameId="ac-evo"
        routePrefix="/ac-evo"
        gameLabel="AC EVO"
        cars={cars}
      />
    </div>
  );
}

export const Route = createFileRoute("/ac-evo/setups/")({
  component: AcEvoTunesPage,
});
