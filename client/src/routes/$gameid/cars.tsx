import { createFileRoute, useParams } from "@tanstack/react-router";
import { CarsPage } from "@/components/cars/CarsPage";
import { AcEvoCars } from "../../components/ac-evo/AcEvoCars";
import { AccCars } from "../../components/acc/AccCars";
import { F1Cars } from "../../components/f1/cars/F1Cars";
import { IRacingCars } from "../../components/iracing/IRacingCars";
import { RaceResultSummary } from "../../components/race-results/ResultSummary";

type CarsSearch = { compare?: string };

function CarsRoute() {
  const { gameid } = useParams({ from: "/$gameid/cars" });
  const page = gameid === "ac-evo" ? <AcEvoCars /> : gameid === "acc" ? <AccCars /> : gameid === "f125" ? <F1Cars /> : gameid === "iracing" ? <IRacingCars /> : <CarsPage />;
  const summaryGameId = gameid === "f125" ? "f1-2025" : gameid;
  return (
    <>
      <RaceResultSummary gameId={summaryGameId as Parameters<typeof RaceResultSummary>[0]["gameId"]} title="Car result summary" />
      {page}
    </>
  );
}

export const Route = createFileRoute("/$gameid/cars")({
  component: CarsRoute,
  validateSearch: (search: Record<string, unknown>): CarsSearch => ({
    compare: typeof search.compare === "string" ? search.compare : undefined,
  }),
});
