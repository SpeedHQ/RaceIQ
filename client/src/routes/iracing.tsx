import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { gameStore } from "../stores/game";

function IRacingLayout() {
  const setGameId = gameStore.actions.setGameId;
  useEffect(() => {
    setGameId("iracing");
    return () => setGameId(null);
  }, [setGameId]);
  return <Outlet />;
}

export const Route = createFileRoute("/iracing")({
  component: IRacingLayout,
});
