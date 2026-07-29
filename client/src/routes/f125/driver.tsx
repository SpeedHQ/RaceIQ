import { createFileRoute } from "@tanstack/react-router";
import { DriverProfilePage } from "../../components/driver/DriverProfilePage";

export const Route = createFileRoute("/f125/driver")({
  component: DriverProfilePage,
});
