import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { ComboDash2 } from "../components/dashes/ComboDash2";
import { useGameStore } from "../stores/game";
import { useTelemetryStore } from "../stores/telemetry";
import type { GameId } from "@shared/types";
import { isPreviewMode, seedDashPreviewState } from "./dash-preview-state";

function ComboDash2Route() {
  const setGameId = useGameStore((s) => s.setGameId);
  const detectedGameId = useTelemetryStore((s) => s.serverStatus?.detectedGame?.id) as
    | GameId
    | null
    | undefined;

  const preview = isPreviewMode();

  useEffect(() => {
    if (preview) {
      seedDashPreviewState();
      return;
    }
    if (detectedGameId) setGameId(detectedGameId);
    return () => setGameId(null);
  }, [detectedGameId, setGameId, preview]);

  return <ComboDash2 />;
}

export const Route = createFileRoute("/dash/combo-2")({
  component: ComboDash2Route,
});
