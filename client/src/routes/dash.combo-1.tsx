import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { ComboDash } from "../components/dashes/ComboDash";
import { useGameStore } from "../stores/game";
import { useTelemetryStore } from "../stores/telemetry";
import { useUnits } from "../hooks/useUnits";
import { tryGetGame } from "@shared/games/registry";
import type { GameId } from "@shared/types";

function ComboDash1Route() {
  const setGameId = useGameStore((s) => s.setGameId);
  const rawPacket = useTelemetryStore((s) => s.rawPacket);
  const packet = useTelemetryStore((s) => s.packet);
  const sectors = useTelemetryStore((s) => s.sectors);
  const pit = useTelemetryStore((s) => s.pit);
  const unitSystem = useTelemetryStore((s) => s.unitSystem);
  const detectedGameId = useTelemetryStore((s) => s.serverStatus?.detectedGame?.id) as
    | GameId
    | null
    | undefined;
  const units = useUnits();
  const game = detectedGameId ? tryGetGame(detectedGameId) : null;

  useEffect(() => {
    if (detectedGameId) setGameId(detectedGameId);
    return () => setGameId(null);
  }, [detectedGameId, setGameId]);

  return (
    <ComboDash
      rawPacket={rawPacket}
      packet={packet}
      sectors={sectors}
      pit={pit}
      unitSystem={unitSystem}
      tireHealthThresholds={game?.tireHealthThresholds}
      toTempC={units.toTempC}
    />
  );
}

export const Route = createFileRoute("/dash/combo-1")({
  component: ComboDash1Route,
});
