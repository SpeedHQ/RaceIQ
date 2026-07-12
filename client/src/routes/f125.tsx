import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { useGameStore } from "../stores/game";

function F125Layout() {
  const setGameId = useGameStore((s) => s.setGameId);
  useEffect(() => {
    setGameId("f1-2025");
    return () => setGameId(null);
  }, [setGameId]);
  return <Outlet />;
}

export const Route = createFileRoute("/f125")({
  component: F125Layout,
});
