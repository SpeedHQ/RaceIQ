import type { GameId } from "@shared/games/ids";
import { useEffect, useMemo } from "react";
import { TrackGeometryWorkspace } from "./TrackGeometryWorkspace";
import { useTrackGeometryEditor } from "./useTrackGeometryEditor";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import type { TrackMapLayerKey, TrackMapLayerState } from "@/components/track-map/types";
import type { TrackInfo } from "../types";

const defaultLayers: TrackMapLayerState = {
  imagery: false,
  boundaries: true,
  pitLane: true,
  outline: true,
  racingLine: false,
  segments: true,
  sectors: false,
  curbs: false,
  trace: false,
  inputs: false,
  highlights: false,
  car: false,
};

export interface DevTrackGeometryPageProps {
  gameId: GameId;
  track: TrackInfo;
  mode: "turns" | "sectors";
  onModeChange: (mode: "turns" | "sectors") => void;
}

export function DevTrackGeometryPage({ gameId, track, mode, onModeChange }: DevTrackGeometryPageProps) {
  const model = useTrackGeometryEditor({ gameId, track });
  const [storedLayers, setStoredLayers] = useLocalStorage<Partial<TrackMapLayerState>>("dev-track-map-layers", {});
  const layers = useMemo(() => ({ ...defaultLayers, ...storedLayers }), [storedLayers]);

  useEffect(() => {
    const required: TrackMapLayerKey = mode === "turns" ? "segments" : "sectors";
    if (layers[required]) return;
    setStoredLayers((previous) => ({ ...previous, [required]: true }));
  }, [layers, mode, setStoredLayers]);

  const onLayerChange = (key: TrackMapLayerKey, checked: boolean) => {
    setStoredLayers((previous) => ({ ...previous, [key]: checked }));
  };

  return (
    <div className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Geometry mode">
        {(["turns", "sectors"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={mode === value}
            data-testid={`dev-geometry-mode-${value}`}
            className={`rounded-md border px-3 py-1.5 text-app-label ${mode === value ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-app-border-input text-app-text-secondary"}`}
            onClick={() => onModeChange(value)}
          >
            {value === "turns" ? "Turns" : "Sectors"}
          </button>
        ))}
      </div>
      <TrackGeometryWorkspace model={model} mode={mode} layers={layers} onLayerChange={onLayerChange} editorScope="active" />
    </div>
  );
}
