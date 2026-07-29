import { createFileRoute } from "@tanstack/react-router";
import { IRacingCars } from "../../components/iracing/IRacingCars";

export const Route = createFileRoute("/iracing/cars")({
  component: IRacingCars,
});
