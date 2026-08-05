import { createFileRoute, useParams } from "@tanstack/react-router";
import { AcEvoCars } from "../../components/ac-evo/AcEvoCars";
import { AccCars } from "../../components/acc/AccCars";
import { CarsPage } from "../../components/CarsPage";
import { F1Cars } from "../../components/f1/F1Cars";
import { IRacingCars } from "../../components/iracing/IRacingCars";

type CarsSearch = { compare?: string };

function CarsRoute() {
  const { gameid } = useParams({ from: "/$gameid/cars" });
  const page = gameid === "ac-evo" ? <AcEvoCars /> : gameid === "acc" ? <AccCars /> : gameid === "f125" ? <F1Cars /> : gameid === "iracing" ? <IRacingCars /> : <CarsPage />;
  return page;
}

export const Route = createFileRoute("/$gameid/cars")({
  component: CarsRoute,
  validateSearch: (search: Record<string, unknown>): CarsSearch => ({
    compare: typeof search.compare === "string" ? search.compare : undefined,
  }),
});
