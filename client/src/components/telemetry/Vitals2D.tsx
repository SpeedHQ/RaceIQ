import type { SemanticAnalysisFrame } from "../track-map/types";
import type { GameId } from "@shared/games/ids";
import type { LiveTelemetryView } from "../../lib/live-telemetry-view";
import { useUnits } from "../../hooks/useUnits";
import { GForceCircle } from "./GForceCircle";
import { TireDiagram } from "./TireDiagram";

/** Semantic 2D telemetry panel; unavailable values remain unavailable. */
export function Vitals2D({ frame, view, gameId }: { frame?: SemanticAnalysisFrame; view?: LiveTelemetryView; gameId?: GameId }) {
  const units = useUnits();
  const speed = view?.motion.speedMps ?? number(frame, "motion.speed");
  const gear = view?.inputs.gear ?? number(frame, "inputs.gear");
  return (
    <div className="flex flex-col items-center gap-2 w-full">
      <div className="flex items-center justify-center gap-2">
        <span className="text-lg font-mono font-bold text-app-accent">{gear == null ? "—" : gear === 0 ? "R" : gear === 11 ? "N" : gear}</span>
        <span className="text-xl font-mono font-bold tabular-nums text-app-text">
          {speed == null ? "—" : units.speed(speed).toFixed(0)} <span className="text-app-caption text-app-text-muted">{units.speedLabel}</span>
        </span>
      </div>
      <div className="flex items-center gap-2"><GForceCircle frame={frame} view={view} /></div>
      <TireDiagram frame={frame} view={view} gameId={gameId} />
    </div>
  );
}

function number(frame: SemanticAnalysisFrame | undefined, id: keyof SemanticAnalysisFrame["values"]): number | null { const value = frame?.values[id];
return typeof value === "number" && Number.isFinite(value) ? value : null; }
