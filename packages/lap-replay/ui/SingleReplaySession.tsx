import type { TrackProjection } from "@raceiq/scene-3d/wireframe/ScenePlacement";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import type { SemanticLapTelemetry } from "../contracts/replay";
import type { ReplayOpponentMetadata, ReplaySession as ReplaySessionData, SpectateController, SpectateSegment } from "../contracts/spectate";
import type { OpponentSemanticLapTelemetry } from "../contracts/opponents";
import { createSpectateController, placeIRacingSpectateLaps, prepareSpectateLap } from "./spectate-replay";
import { SpectateView } from "./SpectateView";
import { useLocalStorage, useSettings } from "./host";
export interface SingleReplaySessionProps {
  gameId: GameId;
  lap: LapMeta | ReplayOpponentMetadata;
  replay: SemanticLapTelemetry | OpponentSemanticLapTelemetry;
  outline: readonly { x: number; z: number }[] | null;
  trackProjection?: TrackProjection | null;
  segments: readonly SpectateSegment[];
  trackLengthM?: number;
  initialFrame?: number;
  ai: (headerTarget: HTMLDivElement | null) => ReactNode;
  aiOpen: boolean;
  onAiOpenChange: (open: boolean) => void;
  onController?: (controller: SpectateController | null) => void;
  panelHeaderTarget: HTMLDivElement | null;
}

/** One native replay clock rendered through the same scene and panels as comparison. */
export function SingleReplaySession({ gameId, lap, replay, outline, trackProjection, segments, trackLengthM, initialFrame, ai, aiOpen, onAiOpenChange, onController, panelHeaderTarget }: SingleReplaySessionProps) {
  const a = useMemo(() => {
    const prepared = prepareSpectateLap(replay);
    if (typeof trackLengthM === "number" && Number.isFinite(trackLengthM) && trackLengthM > 0) prepared.trackLengthM = trackLengthM;
    return gameId === "iracing" ? placeIRacingSpectateLaps([prepared, prepared], trackProjection ?? null)[0] : prepared;
  }, [gameId, replay, trackLengthM, trackProjection]);
  const session = useMemo<ReplaySessionData>(() => ({
    gameId,
    a,
    b: null,
    comparison: { lapA: lap, lapB: null },
  }), [gameId, lap, a]);
  const { displaySettings } = useSettings();
  const initialFrameRef = useRef(initialFrame);
  initialFrameRef.current = initialFrame;
  const onControllerRef = useRef(onController);
  onControllerRef.current = onController;
  const fpsCapRef = useRef(displaySettings.renderFpsCap);
  fpsCapRef.current = displaySettings.renderFpsCap;
  const [telemetryOpen, setTelemetryOpen] = useLocalStorage("replay-telemetry-open", false);
  const [carPanelOpen, setCarPanelOpen] = useLocalStorage("replay-car-open", false);
  const [active, setActive] = useState<{ a: ReplaySessionData["a"]; gameId: GameId; controller: SpectateController } | null>(null);
  const controller = active?.a === a && active.gameId === gameId ? active.controller : null;
  useEffect(() => {
    const next = createSpectateController(a, null, undefined, () => fpsCapRef.current);
    next.setActive(true);
    const frame = initialFrameRef.current;
    if (frame !== undefined && Number.isInteger(frame) && frame >= 0) next.seekFrame("a", frame);
    setActive({ a, gameId, controller: next });
    onControllerRef.current?.(next);
    return () => {
      next.setActive(false);
      onControllerRef.current?.(null);
      next.dispose();
    };
  }, [a, gameId]);

  useEffect(() => {
    if (!controller) return;
    const handleKey = (event: KeyboardEvent) => {
      const arrow = event.key === "ArrowLeft" || event.key === "ArrowRight";
      if ((!arrow && event.code !== "Space" && event.key !== " ") || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('textarea, select, [role="textbox"], [role="dialog"], [role="alertdialog"]'))) return;
      if (target instanceof HTMLInputElement && !["range", "checkbox", "radio", "button", "submit", "reset"].includes(target.type)) return;
      if (arrow && target instanceof Element && target.closest('input, [role="separator"], [role="slider"], [role="combobox"], [role="listbox"], [role="tablist"], [role="menu"], [role="tree"], [role="grid"], [role="spinbutton"], [role="radiogroup"], [role="toolbar"]')) return;
      event.preventDefault();
      event.stopPropagation();
      if (arrow) {
        if (event.type !== "keydown" || a.samples.length === 0) return;
        const time = controller.getFrameSnapshot(performance.now()).time;
        let low = 0, high = a.samples.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (a.samples[middle]!.time < time || (event.key === "ArrowRight" && a.samples[middle]!.time === time)) low = middle + 1;
          else high = middle;
        }
        const index = Math.max(0, Math.min(a.samples.length - 1, event.key === "ArrowLeft" ? low - 1 : low));
        controller.scrub(a.samples[index]!.time);
        return;
      }
      if (event.type === "keydown" && !event.repeat) {
        if (controller.getSnapshot().playing) controller.pause();
        else controller.play();
      }
    };
    window.addEventListener("keydown", handleKey, true);
    window.addEventListener("keyup", handleKey, true);
    return () => {
      window.removeEventListener("keydown", handleKey, true);
      window.removeEventListener("keyup", handleKey, true);
    };
  }, [a, controller]);
  if (!controller) return null;
  return <SpectateView pair={session} controller={controller} outline={outline} segments={segments}
    ai={ai} aiOpen={aiOpen} onAiOpenChange={onAiOpenChange} telemetryOpen={telemetryOpen}
    onTelemetryOpenChange={setTelemetryOpen} carPanelOpen={carPanelOpen} onCarPanelOpenChange={setCarPanelOpen}
    panelHeaderTarget={panelHeaderTarget} />;
}
