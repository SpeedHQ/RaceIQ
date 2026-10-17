import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { useGameStore } from "../stores/game";

function AMS2Layout() {
  const setGameId = useGameStore((state) => state.setGameId);
  useEffect(() => {
    setGameId("ams2");
    return () => setGameId(null);
  }, [setGameId]);
  return <Outlet />;
}

export const Route = createFileRoute("/ams2")({
  component: AMS2Layout,
});
