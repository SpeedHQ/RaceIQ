import { createFileRoute, useParams } from "@tanstack/react-router";
import { CarsPage } from "../../components/CarsPage";
import { AcEvoCars } from "../../components/ac-evo/AcEvoCars";
import { AccCars } from "../../components/acc/AccCars";
import { F1Cars } from "../../components/f1/F1Cars";
import { IRacingCars } from "../../components/iracing/IRacingCars";

type CarsSearch = { compare?: string };

function CarsRoute() {
  const { gameid } = useParams({ from: "/$gameid/cars" });
  if (gameid === "ac-evo") return <AcEvoCars />;
  if (gameid === "acc") return <AccCars />;
  if (gameid === "f125") return <F1Cars />;
  if (gameid === "iracing") return <IRacingCars />;
  return <CarsPage />;
}

export const Route = createFileRoute("/$gameid/cars")({
  component: CarsRoute,
  validateSearch: (search: Record<string, unknown>): CarsSearch => ({
    compare: typeof search.compare === "string" ? search.compare : undefined,
  }),
});
