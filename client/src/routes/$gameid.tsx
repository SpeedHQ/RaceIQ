import { createFileRoute, Outlet, useParams } from "@tanstack/react-router";
import { useEffect } from "react";
import type { GameId } from "@shared/types";
import { useGameStore } from "../stores/game";

const ROUTE_GAME_IDS: Record<string, GameId> = {
  "fm23": "fm-2023",
  "f125": "f1-2025",
  acc: "acc",
  "ac-evo": "ac-evo",
  iracing: "iracing",
};

function DynamicGameLayout() {
  const { gameid } = useParams({ from: "/$gameid" });
  const setGameId = useGameStore((s) => s.setGameId);
  const gameId = ROUTE_GAME_IDS[gameid];

  useEffect(() => {
    setGameId(gameId ?? null);
    return () => setGameId(null);
  }, [gameId, setGameId]);

  return <Outlet />;
}

export const Route = createFileRoute("/$gameid")({
  component: DynamicGameLayout,
});
