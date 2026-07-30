import { createFileRoute } from "@tanstack/react-router";
import { HomePageContainer } from "../../components/HomePageContainer";

export const Route = createFileRoute("/ac-evo/")({
  component: HomePageContainer,
});
