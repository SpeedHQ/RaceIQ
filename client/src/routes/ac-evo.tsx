import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { useGameStore } from "../stores/game";

function AcEvoLayout() {
  const setGameId = useGameStore((s) => s.setGameId);
  useEffect(() => {
    setGameId("ac-evo");
    return () => setGameId(null);
  }, [setGameId]);
  return <Outlet />;
}

export const Route = createFileRoute("/ac-evo")({
  component: AcEvoLayout,
});
