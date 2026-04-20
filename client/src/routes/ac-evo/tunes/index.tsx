import { createFileRoute } from "@tanstack/react-router";
import { SetupTunesPage } from "../../../components/setup-tune/SetupTunesPage";
import { useAcEvoCars } from "../../../components/setup-tune/use-game-cars";

function AcEvoTunesPage() {
  const { data: cars = [] } = useAcEvoCars();
  return (
    <SetupTunesPage
      gameId="ac-evo"
      routePrefix="/ac-evo"
      gameLabel="AC EVO"
      cars={cars}
    />
  );
}

export const Route = createFileRoute("/ac-evo/tunes/")({
  component: AcEvoTunesPage,
});
