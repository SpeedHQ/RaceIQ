import { createFileRoute } from "@tanstack/react-router";
import { DriverProfilePage } from "../../components/driver/DriverProfilePage";
import { gameIdForRoutePrefix, supportsGameFeature } from "../../lib/game-routes";

export const Route = createFileRoute("/$gameid/driver")({
  beforeLoad: ({ params }) => {
    if (!gameIdForRoutePrefix(params.gameid) || !supportsGameFeature(params.gameid, "driver")) {
      throw new Error(`Unsupported driver route: ${params.gameid}`);
    }
  },
  component: DriverProfilePage,
});
