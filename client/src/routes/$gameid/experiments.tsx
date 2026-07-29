import { createFileRoute, Outlet } from "@tanstack/react-router";
import { setupEngineerGameIdForRoutePrefix } from "../../lib/game-routes";

export const Route = createFileRoute("/$gameid/experiments")({
  beforeLoad: ({ params }) => {
    if (!setupEngineerGameIdForRoutePrefix(params.gameid)) {
      throw new Error(`Unsupported experiments route: ${params.gameid}`);
    }
  },
  component: () => <Outlet />,
});
