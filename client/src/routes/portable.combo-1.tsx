import { tryGetGame } from "@shared/games/registry";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import type { GameId } from "../../../shared/games/ids";
import { ComboDash } from "../components/dashes/ComboDash";
import { gameStore, } from "../stores/game";
import { useTelemetryStore } from "../stores/telemetry";

function ComboDash1Route() {
  const setGameId = gameStore.actions.setGameId;
  const view = useTelemetryStore((s) => s.telemetryView);
  const sectors = useTelemetryStore((s) => s.sectors);
  const pit = useTelemetryStore((s) => s.pit);
  const unitSystem = useTelemetryStore((s) => s.unitSystem);
  const detectedGameId = useTelemetryStore((s) => s.serverStatus?.detectedGame?.id) as GameId | null | undefined;
  const game = detectedGameId ? tryGetGame(detectedGameId) : null;

  useEffect(() => {
    if (detectedGameId) setGameId(detectedGameId);
    return () => setGameId(null);
  }, [detectedGameId, setGameId]);

  return <ComboDash view={view} sectors={sectors} pit={pit} unitSystem={unitSystem} tireHealthThresholds={game?.tireHealthThresholds} />;
}

export const Route = createFileRoute("/portable/combo-1")({
  component: ComboDash1Route,
});
