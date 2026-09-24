import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { useGameStore } from "../stores/game";

function LMULayout() {
  const setGameId = useGameStore((state) => state.setGameId);
  useEffect(() => {
    setGameId("lmu");
    return () => setGameId(null);
  }, [setGameId]);
  return <Outlet />;
}

export const Route = createFileRoute("/lmu")({
  component: LMULayout,
});
