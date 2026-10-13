import { createFileRoute, Outlet } from "@tanstack/react-router";
import { gameIdForRoutePrefix } from "../lib/game-routes";


export const Route = createFileRoute("/$gameid")({
  beforeLoad: ({ params }) => {
    if (!gameIdForRoutePrefix(params.gameid)) {
      throw new Error(`Unknown game route prefix: ${params.gameid}`);
    }
  },
  component: Outlet,
});
