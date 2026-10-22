import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { GameId } from "@raceiq/shared/games/ids";
import type { LapMeta } from "@raceiq/shared/racing/sessions/types";
import type { SemanticLapTelemetry } from "../contracts/replay";
import type { ReplaySession as ReplaySessionData, SpectateController, SpectateSegment } from "../contracts/spectate";
import { createSpectateController, prepareSpectateLap } from "./spectate-replay";
import { SpectateView } from "./SpectateView";
import { useLocalStorage, useSettings } from "./host";
export interface SingleReplaySessionProps {
  gameId: GameId;
  lap: LapMeta;
  replay: SemanticLapTelemetry;
  outline: readonly { x: number; z: number }[] | null;
  segments: readonly SpectateSegment[];
  initialFrame?: number;
  ai: (headerTarget: HTMLDivElement | null) => ReactNode;
  aiOpen: boolean;
  onAiOpenChange: (open: boolean) => void;
  onController?: (controller: SpectateController | null) => void;
  panelHeaderTarget: HTMLDivElement | null;
}

/** One native replay clock rendered through the same scene and panels as comparison. */
export function SingleReplaySession({ gameId, lap, replay, outline, segments, initialFrame, ai, aiOpen, onAiOpenChange, onController, panelHeaderTarget }: SingleReplaySessionProps) {
  const a = useMemo(() => prepareSpectateLap(replay), [replay]);
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
    const handleSpace = (event: KeyboardEvent) => {
      if ((event.code !== "Space" && event.key !== " ") || event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('textarea, select, [role="textbox"], [role="dialog"], [role="alertdialog"]'))) return;
      if (target instanceof HTMLInputElement && !["range", "checkbox", "radio", "button", "submit", "reset"].includes(target.type)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.type === "keydown" && !event.repeat) {
        if (controller.getSnapshot().playing) controller.pause();
        else controller.play();
      }
    };
    window.addEventListener("keydown", handleSpace, true);
    window.addEventListener("keyup", handleSpace, true);
    return () => {
      window.removeEventListener("keydown", handleSpace, true);
      window.removeEventListener("keyup", handleSpace, true);
    };
  }, [controller]);
  if (!controller) return null;
  return <SpectateView pair={session} controller={controller} outline={outline} segments={segments}
    ai={ai} aiOpen={aiOpen} onAiOpenChange={onAiOpenChange} telemetryOpen={telemetryOpen}
    onTelemetryOpenChange={setTelemetryOpen} carPanelOpen={carPanelOpen} onCarPanelOpenChange={setCarPanelOpen}
    panelHeaderTarget={panelHeaderTarget} />;
}
