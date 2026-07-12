import { createFileRoute } from "@tanstack/react-router";
import { SetupTuneBrowser } from "../../../components/setup-tune/SetupTuneBrowser";
import { useAccCars } from "../../../components/setup-tune/use-game-cars";

function AccTunesPage() {
  const { data: cars = [] } = useAccCars();
  return (
    <div className="flex-1 overflow-auto">
      <SetupTuneBrowser
        gameId="acc"
        routePrefix="/acc"
        gameLabel="ACC"
        cars={cars}
      />
    </div>
  );
}

export const Route = createFileRoute("/acc/tunes/")({
  component: AccTunesPage,
});
