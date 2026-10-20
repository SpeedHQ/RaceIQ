import { useEffect, useMemo, useState } from "react";
import { useTelemetryStore } from "../stores/telemetry";
import { gameStore } from "../stores/game";
import { tryGetGame } from "@raceiq/shared/games/registry"
import { NoDataView } from "./NoDataView";
import { liveDashboardForGame } from "../lib/game-routes";
import { ForzaLiveDashboard } from "./ForzaLiveDashboard";
import { F1LiveDashboard } from "./f1/F1LiveDashboard";
import { AccLiveDashboard } from "./acc/AccLiveDashboard";
import { LMULiveDashboard } from "./lmu/LMULiveDashboard";
import type { DashboardMode } from "./LiveTelemetry";
import type { GameId } from "@raceiq/shared/games/ids";
import { GameIdSchema } from "@raceiq/shared/games/ids";
import { useSessions } from "../hooks/session-queries";
import { StrategyHistory } from "./telemetry/StrategyHistory";
import { m } from "@/paraglide/messages";

function SavedStrategyHistory({ preferredGameId, currentSessionId }: { preferredGameId: GameId | null; currentSessionId: number | null }) {
  const query = useSessions({ allGames: true });
  const [selectedGameId, setSelectedGameId] = useState<GameId | null>(null);
  const games = useMemo(() => {
    const ids = new Set<GameId>();
    if (preferredGameId) ids.add(preferredGameId);
    for (const session of query.data ?? []) {
      const parsed = GameIdSchema.safeParse(session.gameId);
      if (parsed.success) ids.add(parsed.data);
    }
    return [...ids];
  }, [query.data, preferredGameId]);
  const gameId = selectedGameId && games.includes(selectedGameId) ? selectedGameId : preferredGameId ?? games[0] ?? null;
  if (query.isLoading) return <p role="status" className="p-4">{m.common_loading()}</p>;
  if (query.isError) return <p role="alert" className="p-4">{m.strategy_history_error()} <button type="button" className="underline" onClick={() => void query.refetch()}>{m.strategy_retry()}</button></p>;
  if (!gameId) return null;
  return <div className="space-y-3 border-b border-app-border p-4">
    <label className="block text-sm">{m.analyse_game_label()} <select className="max-w-full rounded border border-app-border bg-app-surface p-1" value={gameId} onChange={(event) => setSelectedGameId(GameIdSchema.parse(event.target.value))}>
      {games.map((id) => <option key={id} value={id}>{tryGetGame(id)?.displayName ?? id}</option>)}
    </select></label>
    <StrategyHistory key={`${gameId}:${gameId === preferredGameId ? currentSessionId : "saved"}`} gameId={gameId} currentSessionId={gameId === preferredGameId ? currentSessionId : null} defaultDriverKey={null} />
  </div>;
}

export function LiveDashboardPage({ mode }: { mode: DashboardMode }) {
  const detectedId = useTelemetryStore((s) => s.serverStatus?.detectedGame?.id);
  const view = useTelemetryStore((s) => s.telemetryView);
  const currentSessionId = useTelemetryStore((s) => s.serverStatus?.currentSession?.id ?? null);
  // Replays provide a simulator on the telemetry view even when periodic
  // source status reports no detected game.
  const gameId = detectedId ?? view?.simulator;
  const game = gameId ? tryGetGame(gameId) : undefined;
  const setGameId = gameStore.actions.setGameId;
  useEffect(() => {
    setGameId(game?.id ?? null);
    return () => setGameId(null);
  }, [game?.id, setGameId]);
  if (!game || !view || view.simulator !== game.id) return mode === "pitcrew"
    ? <div className="flex-1 min-h-0 overflow-y-auto"><SavedStrategyHistory preferredGameId={game?.id ?? null} currentSessionId={currentSessionId} /><NoDataView /></div>
    : <NoDataView />;
  switch (liveDashboardForGame(game.id)) {
    case "forza": return <ForzaLiveDashboard mode={mode} />;
    case "f1": return <F1LiveDashboard />;
    case "acc": return <AccLiveDashboard gameId={game.id} />;
    case "lmu": return <LMULiveDashboard />;
  }
}
