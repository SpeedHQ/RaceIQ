import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { useGameStore } from "../stores/game";

function Fm23Layout() {
  const setGameId = useGameStore((s) => s.setGameId);
  useEffect(() => {
    setGameId("fm-2023");
    return () => setGameId(null);
  }, [setGameId]);
  return <Outlet />;
}

export const Route = createFileRoute("/fm23")({
  component: Fm23Layout,
});
