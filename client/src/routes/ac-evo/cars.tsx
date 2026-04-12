import { createFileRoute } from "@tanstack/react-router";
import { AcEvoCars } from "../../components/ac-evo/AcEvoCars";

export const Route = createFileRoute("/ac-evo/cars")({
  component: AcEvoCars,
});
