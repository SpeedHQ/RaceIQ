import { createFileRoute } from "@tanstack/react-router";
import { CarsPage } from "../../components/CarsPage";

type CarsSearch = {
  compare?: string;
};

export const Route = createFileRoute("/fm23/cars")({
  component: CarsPage,
  validateSearch: (search: Record<string, unknown>): CarsSearch => ({
    compare: typeof search.compare === "string" ? search.compare : undefined,
  }),
});
