import { createFileRoute } from "@tanstack/react-router";
import { DashCatalogue } from "@/components/dashes/DashCatalogue";

export const Route = createFileRoute("/portable/")({ component: DashCatalogue });
