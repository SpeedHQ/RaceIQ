import { ModelLibraryPage } from "@raceiq/car-models/page";
import { createFileRoute } from "@tanstack/react-router";
import { loadCarModelConfigs } from "@/data/car-models";
import { m } from "@/paraglide/messages";

export const Route = createFileRoute("/car-models")({ component: () => <ModelLibraryPage m={m} loadConfigs={loadCarModelConfigs} /> });
