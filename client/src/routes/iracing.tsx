import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { useGameStore } from "../stores/game";

function IRacingLayout() {
  const setGameId = useGameStore((state) => state.setGameId);
  useEffect(() => {
    setGameId("iracing");
    return () => setGameId(null);
  }, [setGameId]);
  return <Outlet />;
}

export const Route = createFileRoute("/iracing")({
  component: IRacingLayout,
});
