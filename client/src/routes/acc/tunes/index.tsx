import { createFileRoute } from "@tanstack/react-router";
import { SetupTunesPage } from "../../../components/setup-tune/SetupTunesPage";
import { useAccCars } from "../../../components/setup-tune/use-game-cars";

function AccTunesPage() {
  const { data: cars = [] } = useAccCars();
  return (
    <SetupTunesPage
      gameId="acc"
      routePrefix="/acc"
      gameLabel="ACC"
      cars={cars}
    />
  );
}

export const Route = createFileRoute("/acc/tunes/")({
  component: AccTunesPage,
});
