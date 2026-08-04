import { createFileRoute } from "@tanstack/react-router";
import { HomePageContainer } from "@/components/home/HomePageContainer";

export const Route = createFileRoute("/fm23/")({
  component: HomePageContainer,
});
