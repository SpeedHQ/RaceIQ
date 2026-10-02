import { useEffect } from "react";
import { useTelemetryStore } from "../stores/telemetry";
import { gameStore } from "../stores/game";
import { tryGetGame } from "@raceiq/games/registry";
import { NoDataView } from "./NoDataView";
import { liveDashboardForGame } from "../lib/game-routes";
import { ForzaLiveDashboard } from "./ForzaLiveDashboard";
import { F1LiveDashboard } from "./f1/F1LiveDashboard";
import { AccLiveDashboard } from "./acc/AccLiveDashboard";
import { LMULiveDashboard } from "./lmu/LMULiveDashboard";
import type { DashboardMode } from "./LiveTelemetry";

export function LiveDashboardPage({ mode }: { mode: DashboardMode }) {
  const detectedId = useTelemetryStore((s) => s.serverStatus?.detectedGame?.id);
  const view = useTelemetryStore((s) => s.telemetryView);
  // Replays provide a simulator on the telemetry view even when periodic
  // source status reports no detected game.
  const gameId = detectedId ?? view?.simulator;
  const game = gameId ? tryGetGame(gameId) : undefined;
  const setGameId = gameStore.actions.setGameId;
  useEffect(() => {
    setGameId(game?.id ?? null);
    return () => setGameId(null);
  }, [game?.id, setGameId]);
  if (!game || !view || view.simulator !== game.id) return <NoDataView />;
  switch (liveDashboardForGame(game.id)) {
    case "forza": return <ForzaLiveDashboard mode={mode} />;
    case "f1": return <F1LiveDashboard />;
    case "acc": return <AccLiveDashboard gameId={game.id} />;
    case "lmu": return <LMULiveDashboard />;
  }
}
