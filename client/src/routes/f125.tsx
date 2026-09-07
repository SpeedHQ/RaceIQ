import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { gameStore, } from "../stores/game";

function F125Layout() {
  const setGameId = gameStore.actions.setGameId;
  useEffect(() => {
    setGameId("f1-2025");
    return () => setGameId(null);
  }, [setGameId]);
  return <Outlet />;
}

export const Route = createFileRoute("/f125")({
  component: F125Layout,
});
