import { useEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Navigation, Footprints, CarFront, Route, Map } from "lucide-react";
import type { SpectateController, SpectatePair } from "./types";
import type { TrackMapBoundaries } from "../../analyse/track-map/types";
import { useSettings } from "@/hooks/settings";
import { useTrackBoundaries } from "@/hooks/track-queries";
import { m } from "@/paraglide/messages";
import { SpectateSceneRuntime, type CarModelMode } from "./SpectateSceneRuntime";
import { FOCUS_ZOOM_SNAP_ZONE_END } from "./spectate-focus-lanes";
import type { SpectateFocus } from "./spectate-focus";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

type ToolbarTooltipProps = Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> & {
  tooltip: string;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
};
function ToolbarTooltip({ tooltip, side = "right", children, ...buttonProps }: ToolbarTooltipProps) {
  return (
    <Tooltip>
      <TooltipTrigger render={<button {...buttonProps} />}>{children}</TooltipTrigger>
      <TooltipContent role="tooltip" side={side}>{tooltip}</TooltipContent>
    </Tooltip>
  );
}
export interface SpectateSceneProps {
  pair: SpectatePair;
  controller: SpectateController;
  outline: readonly { x: number; z: number }[] | null;
  overview: ReactNode;
  focus: SpectateFocus;
}

function useToolbarToggle(key: string, defaultValue: boolean) {
  const [value, setValue] = useState(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored === "true") return true;
      if (stored === "false") return false;
    } catch {
      /* Storage may be unavailable. */
    }
    return defaultValue;
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, String(value));
    } catch {
      /* Keep toggles usable when storage is unavailable. */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

/** Canvas owner for the paired recorded-world scene. */
export function SpectateScene({ pair, controller, outline, overview, focus }: SpectateSceneProps) {
  const { displaySettings } = useSettings();
  const boundaries = useTrackBoundaries(pair.comparison.lapA.trackId, pair.gameId).data as TrackMapBoundaries | undefined;
  const positionLock = useSyncExternalStore(controller.subscribe, () => controller.getSnapshot().positionLock, () => controller.getSnapshot().positionLock);
  const canLock = useSyncExternalStore(controller.subscribe, () => controller.getSnapshot().canLock, () => controller.getSnapshot().canLock);
  const host = useRef<HTMLDivElement>(null);
  const runtime = useRef<SpectateSceneRuntime | null>(null);
  const zoomIndicator = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  const [directionLock, setDirectionLock] = useToolbarToggle("spectate-direction-lock", false);
  const [tireTrails, setTireTrails] = useToolbarToggle("spectate-tire-trails", false);
  const [racingLine, setRacingLine] = useToolbarToggle("spectate-racing-line", false);
  const [positionLockPreferred, setPositionLockPreferred] = useToolbarToggle("spectate-position-lock", true);
  const [overviewVisible, setOverviewVisible] = useToolbarToggle("spectate-track-overview", true);
  const [carModelMode, setCarModelMode] = useState<CarModelMode>("solid");
  const hasRacingLine = Array.isArray(boundaries?.raceLine) && boundaries.raceLine.length > 1;
  const [error, setError] = useState<string | null>(null);
  const [sideAState, setSideAState] = useState("loading");
  const [sideBState, setSideBState] = useState("loading");
  const key = `${pair.gameId}:${pair.comparison.lapA.id}:${pair.comparison.lapB.id}`;
  useEffect(() => {
    setReady(false);
    setError(null);
    setSideAState("loading");
    setSideBState("loading");
    const node = host.current;
    if (!node) return;
    let mounted = true;
    const current = new SpectateSceneRuntime(
      node,
      pair,
      controller,
      (value) => {
        if (mounted) {
          setReady(value);
          setSideAState(runtime.current?.canvas.dataset.sideAState ?? "loading");
          setSideBState(runtime.current?.canvas.dataset.sideBState ?? "loading");
        }
      },
      (message) => {
        if (mounted) {
          setError(message || null);
          setSideAState(runtime.current?.canvas.dataset.sideAState ?? "unavailable");
          setSideBState(runtime.current?.canvas.dataset.sideBState ?? "unavailable");
        }
      },
      (position, available) => {
        const indicator = zoomIndicator.current;
        if (!indicator) return;
        indicator.dataset.zoomPosition = String(position);
        indicator.style.display = available ? "block" : "none";
        indicator.style.setProperty("--zoom-position", `${position * 100}%`);
      },
      new URLSearchParams(location.search).get("forceWebGL") === "true",
      displaySettings.renderFpsCap,
    );
    runtime.current = current;
    return () => {
      mounted = false;
      runtime.current = null;
      current.dispose();
    };
  }, [key, controller, displaySettings.renderFpsCap]);
  useEffect(() => {
    runtime.current?.setOutline(outline, boundaries ?? null);
  }, [outline, boundaries, key, controller, displaySettings.renderFpsCap]);
  useEffect(() => {
    runtime.current?.setFocus(focus);
  }, [focus, key, controller, displaySettings.renderFpsCap]);
  useEffect(() => {
    runtime.current?.setDirectionLock(directionLock);
  }, [directionLock, key, controller, displaySettings.renderFpsCap]);
  useEffect(() => {
    runtime.current?.setCarModelMode(carModelMode);
  }, [carModelMode, key, controller, displaySettings.renderFpsCap]);
  useEffect(() => {
    runtime.current?.setTireTrails(tireTrails);
  }, [tireTrails, key, controller, displaySettings.renderFpsCap]);
  useEffect(() => {
    runtime.current?.setRacingLine(racingLine && hasRacingLine);
  }, [racingLine, hasRacingLine, key, controller, displaySettings.renderFpsCap]);
  useEffect(() => {
    controller.setPositionLock(positionLockPreferred);
  }, [controller, canLock, positionLockPreferred]);
  return (
    <div
      className="relative h-full min-h-0 w-full overflow-hidden bg-app-bg"
      data-spectate-scene=""
      data-scene-ready={ready ? "true" : "false"}
      data-scene-error={error ?? ""}
      data-side-a-state={sideAState}
      data-side-b-state={sideBState}
    >
      <div ref={host} className="absolute inset-0" />
      <div
        ref={zoomIndicator}
        data-spectate-zoom-indicator=""
        data-snap-zone-end={FOCUS_ZOOM_SNAP_ZONE_END}
        aria-hidden="true"
        className="absolute left-14 top-1/2 z-30 -translate-y-1/2 rounded-sm border border-app-border bg-app-surface/90 p-2"
        style={{ display: "none" }}
      >
        <div className="relative h-24 w-1.5 rounded bg-app-border">
          <div
            className="absolute inset-x-0 top-0 rounded bg-app-accent/35"
            style={{ height: `${FOCUS_ZOOM_SNAP_ZONE_END * 100}%` }}
          />
          <div className="absolute left-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-app-bg bg-app-text" style={{ top: "var(--zoom-position)" }} />
        </div>
      </div>
      {overviewVisible && overview}
      {ready && !error && (
        <TooltipProvider delay={0}>
          <div role="toolbar" aria-label={m.spectate_direction_lock()} aria-orientation="vertical" className="absolute left-3 top-1/2 z-30 flex -translate-y-1/2 flex-col rounded-sm border border-app-border bg-app-surface/90 p-0">
            <ToolbarTooltip
              type="button"
              role="switch"
              aria-checked={overviewVisible}
              aria-label={m.spectate_overview()}
              tooltip={m.spectate_overview()}
              onClick={() => setOverviewVisible((shown) => !shown)}
              className={`flex size-7 items-center justify-center border p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent ${overviewVisible ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-transparent text-app-text-secondary hover:text-app-accent"}`}
            >
              <Map size={16} aria-hidden="true" />
            </ToolbarTooltip>
            <ToolbarTooltip
              type="button"
              data-spectate-car-model-toggle=""
              data-car-model-mode={carModelMode}
              aria-label={carModelMode === "solid" ? m.carwire_solid() : carModelMode === "wire" ? m.carwire_wire() : m.carwire_hidden()}
              tooltip={carModelMode === "solid" ? m.carwire_solid() : carModelMode === "wire" ? m.carwire_wire() : m.carwire_hidden()}
              onClick={() => setCarModelMode((mode) => mode === "wire" ? "solid" : mode === "solid" ? "hidden" : "wire")}
              className={`flex size-7 items-center justify-center border p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent ${carModelMode !== "wire" ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-transparent text-app-text-secondary hover:text-app-accent"}`}
            >
              <CarFront size={16} aria-hidden="true" />
            </ToolbarTooltip>
            <ToolbarTooltip
              type="button"
              role="switch"
              aria-checked={directionLock}
              aria-label={m.spectate_direction_lock()}
              tooltip={m.spectate_direction_lock()}
              onClick={() => setDirectionLock((locked) => !locked)}
              className={`flex size-7 items-center justify-center border p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent ${directionLock ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-transparent text-app-text-secondary hover:text-app-accent"}`}
            >
              <Navigation size={16} className="-rotate-45" aria-hidden="true" />
            </ToolbarTooltip>
            <ToolbarTooltip
              type="button"
              role="switch"
              aria-checked={tireTrails}
              aria-label={m.spectate_tire_trails()}
              tooltip={m.spectate_tire_trails()}
              onClick={() => setTireTrails((shown) => !shown)}
              className={`flex size-7 items-center justify-center border p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent ${tireTrails ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-transparent text-app-text-secondary hover:text-app-accent"}`}
            >
              <Footprints size={16} aria-hidden="true" />
            </ToolbarTooltip>
            <ToolbarTooltip
              type="button"
              role="switch"
              aria-checked={racingLine}
              aria-label={m.overlay_racing_line()}
              tooltip={m.overlay_racing_line()}
              onClick={() => setRacingLine((shown) => !shown)}
              className={`flex size-7 items-center justify-center border p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent ${racingLine ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-transparent text-app-text-secondary hover:text-app-accent"}`}
            >
              <Route size={16} className={hasRacingLine ? undefined : "opacity-40"} aria-hidden="true" />
            </ToolbarTooltip>
            <ToolbarTooltip
              type="button"
              role="switch"
              aria-checked={positionLock}
              disabled={!canLock}
              aria-label={m.spectate_position_lock()}
              tooltip={canLock ? m.spectate_position_lock() : m.spectate_position_lock_unavailable()}
              onClick={() => setPositionLockPreferred((locked) => !locked)}
              className={`flex size-7 items-center justify-center border p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent disabled:cursor-not-allowed disabled:opacity-50 ${positionLock ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-transparent text-app-text-secondary hover:text-app-accent"}`}
            >
              <span className="flex items-center gap-0.5" aria-hidden="true">
                <CarFront size={10} />
                <CarFront size={10} />
              </span>
            </ToolbarTooltip>
          </div>
        </TooltipProvider>
      )}
      {error && (
        <div role="alert" className="absolute inset-x-4 top-4 z-10 flex items-center justify-between gap-3 border border-app-border bg-app-surface p-3 text-app-body text-app-text">
          <span>
            {m.spectate_scene_error({
              detail: error === "scene.model-unavailable" ? m.spectate_model_unavailable() : error === "scene.pose-unavailable" ? m.spectate_pose_unavailable() : m.spectate_renderer_unavailable(),
            })}
          </span>
          <button type="button" className="rounded-sm border border-app-border-input px-3 py-1 text-app-label text-app-text-secondary hover:text-app-accent" onClick={() => runtime.current?.retry()}>
            {m.spectate_retry()}
          </button>
        </div>
      )}
      {!error && ready && [sideAState, sideBState].some((state) => state.endsWith("unavailable")) && (
        <div role="status" className="absolute right-3 top-3 z-10 max-w-[16rem] rounded-sm border border-app-border bg-app-surface/90 p-2 text-app-label text-status-unavailable">
          {[sideAState, sideBState].map((state, index) =>
            state.endsWith("unavailable") ? (
              <p key={index}>
                {index === 0 ? "A" : "B"}: {state === "model-unavailable" ? m.spectate_model_unavailable() : m.spectate_pose_unavailable()}
              </p>
            ) : null,
          )}
          <button type="button" className="mt-1 text-app-accent" onClick={() => runtime.current?.retry()}>
            {m.spectate_retry()}
          </button>
        </div>
      )}
      {!ready && !error && (
        <div role="status" className="absolute inset-x-4 top-4 z-10 border border-app-border bg-app-surface p-3 text-app-label text-app-text-secondary">
          {m.spectate_scene_loading()}
        </div>
      )}
    </div>
  );
}
