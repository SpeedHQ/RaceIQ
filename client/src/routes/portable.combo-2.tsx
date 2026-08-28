import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import type { GameId } from "../../../shared/games/ids";
import { ComboDash2 } from "../components/dashes/ComboDash2";
import { gameStore, } from "../stores/game";
import { useTelemetryStore } from "../stores/telemetry";

function ComboDash2Route() {
  const setGameId = gameStore.actions.setGameId;
  const view = useTelemetryStore((s) => s.telemetryView);
  const sessionLaps = useTelemetryStore((s) => s.sessionLaps);
  const detectedGameId = useTelemetryStore((s) => s.serverStatus?.detectedGame?.id) as GameId | null | undefined;

  useEffect(() => {
    if (detectedGameId) setGameId(detectedGameId);
    return () => setGameId(null);
  }, [detectedGameId, setGameId]);

  return <ComboDash2 view={view} sessionLaps={sessionLaps} />;
}

export const Route = createFileRoute("/portable/combo-2")({
  component: ComboDash2Route,
});
