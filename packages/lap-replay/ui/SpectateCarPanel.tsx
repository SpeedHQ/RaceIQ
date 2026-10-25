import { useSyncExternalStore } from "react";
import type { SemanticAnalysisFrame } from "@raceiq/scene-3d/semantic-frame";
import { useMessages } from "./host"
import { TireDiagram } from "./host"
import type { SpectateController, ReplaySession } from "../contracts/spectate";

const EMPTY_METADATA = {};

export function SpectateCarPanel({ pair, controller }: { pair: ReplaySession; controller: SpectateController }) { const m = useMessages(); const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
return (
  <div data-testid="spectate-car-panel" className="h-full overflow-y-auto">
    {[{ side: "A", reading: snapshot.a, lap: pair.comparison.lapA, color: pair.b ? "var(--comparison-lap-a)" : "var(--app-accent)" },
      ...(pair.b && pair.comparison.lapB ? [{ side: "B", reading: snapshot.b, lap: pair.comparison.lapB, color: "var(--comparison-lap-b)" }] : [])].map(({ side, reading, lap, color }) => {
      const label = "kind" in lap ? "Opponent" : `${m.compare_lap_label()} ${lap.lapNumber}`;
      const frame: SemanticAnalysisFrame | null = reading ? { values: reading.values, states: EMPTY_METADATA, freshness: EMPTY_METADATA } : null;
      return (
        <section key={side} aria-label={pair.b ? `${side} — ${label}` : label} className="border-b border-app-border last:border-b-0">
          <h3 className="sticky top-0 z-10 border-b border-app-border border-l-2 bg-app-bg px-3 py-2 text-app-label font-semibold" style={{ borderLeftColor: color }}>
            {pair.b && <><span style={{ color }}>{side}</span> — </>}{label}
          </h3>
          <div className="overflow-x-auto p-2">
            {frame ? <TireDiagram frame={frame} gameId={pair.gameId} readable /> : <p className="p-2 text-app-detail text-app-text-muted">{m.compare_telemetry_unavailable()}</p>}
          </div>
        </section>
      );
    })}
  </div>
); }
