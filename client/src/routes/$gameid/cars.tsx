import { createFileRoute, useParams } from "@tanstack/react-router";
import { CarsPage, AcEvoCars, AccCars, F1Cars, IRacingCars, LMUCars } from "@raceiq/cars-catalogue/ui";

type CarsSearch = { compare?: string };

function CarsRoute() {
  const { gameid } = useParams({ from: "/$gameid/cars" });
  const page =
    gameid === "ac-evo" ? <AcEvoCars /> : gameid === "acc" ? <AccCars /> : gameid === "f125" ? <F1Cars /> : gameid === "iracing" ? <IRacingCars /> : gameid === "lmu" ? <LMUCars /> : gameid === "ams2" ? <IRacingCars gameId="ams2" /> : <CarsPage />;
  return page;
}

export const Route = createFileRoute("/$gameid/cars")({
  component: CarsRoute,
  validateSearch: (search: Record<string, unknown>): CarsSearch => ({
    compare: typeof search.compare === "string" ? search.compare : undefined,
  }),
});
