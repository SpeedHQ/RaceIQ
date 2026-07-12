import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { ComboDash2 } from "../components/dashes/ComboDash2";
import { useGameStore } from "../stores/game";
import { useTelemetryStore } from "../stores/telemetry";
import type { GameId } from "@shared/types";

function ComboDash2Route() {
  const setGameId = useGameStore((s) => s.setGameId);
  const rawPacket = useTelemetryStore((s) => s.rawPacket);
  const sessionLaps = useTelemetryStore((s) => s.sessionLaps);
  const detectedGameId = useTelemetryStore((s) => s.serverStatus?.detectedGame?.id) as GameId | null | undefined;

  useEffect(() => {
    if (detectedGameId) setGameId(detectedGameId);
    return () => setGameId(null);
  }, [detectedGameId, setGameId]);

  return <ComboDash2 rawPacket={rawPacket} sessionLaps={sessionLaps} />;
}

export const Route = createFileRoute("/dash/combo-2")({
  component: ComboDash2Route,
});
