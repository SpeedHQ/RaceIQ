import { useEffect, useRef, useState, useSyncExternalStore, type ButtonHTMLAttributes, type ReactNode } from "react";
import { Navigation, Footprints, CarFront, Route, Map, Info, X } from "lucide-react";
import type { SpectateController, ReplaySession } from "../contracts/spectate";
import type { TrackMapBoundaries } from "../contracts/host"
import { useSettings, useReplayHost, useUnits, useTirePressureOptimal } from "./host"
import { useTrackBoundaries } from "./host"
import { useMessages } from "./host"
import { SpectateSceneRuntime, type CarModelMode } from "./SpectateSceneRuntime"
import { FOCUS_ZOOM_SNAP_ZONE_END } from "./spectate-focus-lanes";
import type { SpectateFocus } from "./spectate-focus";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./host"
import { useSceneMode } from "./useSceneMode";

const CAR_MODEL_MODES: readonly CarModelMode[] = ["solid", "hidden", "wire"];

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
  pair: ReplaySession;
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

/** Canvas owner for one recorded replay, optionally paired for comparison. */
export function SpectateScene({ pair, controller, outline, overview, focus }: SpectateSceneProps) { const { models, getLocale } = useReplayHost(); const m = useMessages(); const { displaySettings } = useSettings();
const boundaries = useTrackBoundaries(pair.comparison.lapA.trackId, pair.gameId).data as TrackMapBoundaries | undefined;
const positionLock = useSyncExternalStore(controller.subscribe, () => controller.getSnapshot().positionLock, () => controller.getSnapshot().positionLock);
const canLock = useSyncExternalStore(controller.subscribe, () => controller.getSnapshot().canLock, () => controller.getSnapshot().canLock);
const host = useRef<HTMLDivElement>(null);
const runtime = useRef<SpectateSceneRuntime | null>(null);
const zoomIndicator = useRef<HTMLDivElement>(null);
const [ready, setReady] = useState(false);
const [directionLock, setDirectionLock] = useToolbarToggle("spectate-direction-lock", false);
const [tireTrails, setTireTrails] = useToolbarToggle("spectate-tire-trails", false);
const [tireInfo, setTireInfo] = useToolbarToggle("spectate-tire-info", false);
const units = useUnits(pair.gameId);
const locale = getLocale();
const pressureA = useTirePressureOptimal(pair.gameId, pair.comparison.lapA.carId, tireInfo);
const pressureB = useTirePressureOptimal(pair.gameId, pair.comparison.lapB?.carId, tireInfo && !!pair.b);
const opponentReplay = pair.b === null && "kind" in pair.comparison.lapA && pair.comparison.lapA.kind === "opponent";
const [racingLine, setRacingLine] = useToolbarToggle(opponentReplay ? "spectate-opponent-racing-line" : "spectate-racing-line", opponentReplay);
const [positionLockPreferred, setPositionLockPreferred] = useToolbarToggle("spectate-position-lock", true);
const [overviewVisible, setOverviewVisible] = useToolbarToggle("spectate-track-overview", true);
const [carModelMode, setCarModelMode] = useSceneMode<CarModelMode>("spectate-car-model-mode", "solid", CAR_MODEL_MODES);
const hasRacingLine = Array.isArray(boundaries?.raceLine) && boundaries.raceLine.length > 1;
const [error, setError] = useState<string | null>(null);
const [sideAState, setSideAState] = useState("loading");
const [sideBState, setSideBState] = useState("loading");
const key = `${pair.gameId}:${pair.comparison.lapA.id}:${pair.comparison.lapB?.id ?? "single"}`;
useEffect(() => {
  setReady(false);
  setError(null);
  setSideAState("loading");
  setSideBState("loading");
  const node = host.current;
  if (!node) return;
  let mounted = true;
  const current = new SpectateSceneRuntime(node,
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
  displaySettings.renderFpsCap, models);
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
  runtime.current?.setTireInfo(tireInfo, {
    fmtTemp: (value) => `${units.temp(value).toFixed(0)}${units.tempLabel}`,
    temperatureLabels: {
      inner: m.label_inner(), middle: m.label_middle(), outer: m.label_outer(),
      core: m.label_core(), carcass: m.label_carcass(), surface: m.label_surface(),
    },
    pitTemperatureLabel: m.analyse_wheels_pit_temp(), carcassLabel: m.label_carcass(),
    pitHealthLabel: m.analyse_wheels_pit_health(), coldPressureLabel: m.analyse_wheels_cold_pressure(),
    pressureLabel: m.analyse_wheels_pressure(), brakeLabel: m.analyse_wheels_brake(),
    wearRateLabel: m.analyse_wheels_wear_s(), snapshotStaleLabel: m.carwire_snapshot_stale(),
    pressureOptimal: [pressureA, pressureB],
  });
}, [tireInfo, units.temp, units.tempLabel, pressureA, pressureB, m, locale, key, controller, displaySettings.renderFpsCap]);
useEffect(() => {
  runtime.current?.setRacingLine(racingLine);
}, [racingLine, key, controller, displaySettings.renderFpsCap]);
useEffect(() => {
  controller.setPositionLock(pair.b !== null && positionLockPreferred);
}, [controller, canLock, positionLockPreferred, pair.b]);
useEffect(() => {
  const target = window as Window & {
    __recording?: boolean;
    __setFrame?: (index: number) => Promise<void>;
    __totalFrames?: number;
    __frameTimes?: number[];
    __captureSceneBitmap?: () => Promise<ImageBitmap>;
  };
  if (!target.__recording || pair.b) return;
  target.__totalFrames = pair.a.replay.envelopes.length;
  target.__frameTimes = pair.a.replay.envelopes.map((frame) => {
    const clock = frame.values.find((entry) => entry.semanticId === "timing.current-lap");
    return clock && typeof clock.value === "number"
      && (clock.state == null || clock.state === "ok")
      && (clock.freshness == null || clock.freshness === "fresh")
      ? clock.value
      : Number.NaN;
  });
  target.__setFrame = (index) => {
    const current = runtime.current;
    return current ? current.requestFrame(index) : Promise.reject(new Error("Replay scene unavailable"));
  };
  target.__captureSceneBitmap = () => runtime.current
    ? runtime.current.captureBitmap()
    : Promise.reject(new Error("Replay scene unavailable"));
  return () => {
    delete target.__setFrame;
    delete target.__totalFrames;
    delete target.__frameTimes;
    delete target.__captureSceneBitmap;
  };
}, [pair, key]);
return (
  <div
    className="absolute inset-0 min-h-0 w-full overflow-hidden bg-app-bg"
    data-replay-scene={pair.b === null ? "" : undefined}
    data-spectate-scene=""
    data-scene-ready={ready ? "true" : "false"}
    data-scene-error={error ?? ""}
    data-side-a-state={sideAState}
    data-side-b-state={pair.b ? sideBState : undefined}
  >
    <div ref={host} className="absolute inset-0" />
    <div
      ref={zoomIndicator}
      data-spectate-zoom-indicator=""
      data-snap-zone-end={FOCUS_ZOOM_SNAP_ZONE_END}
      aria-hidden="true"
      className="absolute left-14 top-1/2 z-30 -translate-y-1/2 rounded-sm border border-app-border bg-app-surface/90 p-2 max-sm:left-16 max-sm:top-44"
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
    {overviewVisible && <div className="contents max-sm:absolute max-sm:bottom-[calc(var(--spectate-inputs-height,8rem)+1.5rem)] max-sm:left-3 max-sm:right-3 max-sm:z-20 max-sm:block max-sm:max-w-[360px]">{overview}
      <button type="button" aria-label={`${m.common_close()} ${m.spectate_overview()}`} onClick={() => setOverviewVisible(false)}
        className="absolute right-2 top-2 z-[60] flex size-11 items-center justify-center rounded-sm text-app-text focus-visible:outline-2 focus-visible:outline-app-accent sm:hidden">
        <X size={18} aria-hidden="true" />
      </button>
    </div>}
      <TooltipProvider delay={0}>
        <div role="toolbar" aria-label={pair.b ? m.spectate_direction_lock() : m.overlay_follow()} aria-orientation="vertical" className="absolute left-3 top-3 z-30 flex flex-col rounded-sm border border-app-border bg-app-surface/90 p-0 sm:top-1/2 sm:-translate-y-1/2">
          <ToolbarTooltip
            type="button"
            role="switch"
            aria-checked={overviewVisible}
            aria-label={m.spectate_overview()}
            tooltip={m.spectate_overview()}
            onClick={() => setOverviewVisible((shown) => !shown)}
            className={`flex size-11 items-center justify-center border p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent sm:size-7 ${overviewVisible ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-transparent text-app-text-secondary hover:text-app-accent"}`}
          >
            <Map size={16} aria-hidden="true" />
          </ToolbarTooltip>
          <ToolbarTooltip
            type="button"
            data-spectate-car-model-toggle=""
            data-car-model-mode={carModelMode}
            aria-label={carModelMode === "solid" ? m.carwire_solid() : carModelMode === "wire" ? m.carwire_wire() : m.carwire_hidden()}
            aria-pressed={carModelMode !== "hidden"}
            tooltip={carModelMode === "solid" ? m.carwire_solid() : carModelMode === "wire" ? m.carwire_wire() : m.carwire_hidden()}
            onClick={() => setCarModelMode((mode) => mode === "wire" ? "solid" : mode === "solid" ? "hidden" : "wire")}
            className={`flex size-11 items-center justify-center border p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent sm:size-7 ${carModelMode !== "hidden" ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-transparent text-app-text-secondary hover:text-app-accent"}`}
          >
            <CarFront size={16} aria-hidden="true" />
          </ToolbarTooltip>
          <ToolbarTooltip
            type="button"
            role="switch"
            data-tire-info-toggle=""
            aria-checked={tireInfo}
            aria-label={m.carwire_tire_info()}
            tooltip={m.carwire_tire_info()}
            onClick={() => setTireInfo((shown) => !shown)}
            className={`flex size-11 items-center justify-center border p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent sm:size-7 ${tireInfo ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-transparent text-app-text-secondary hover:text-app-accent"}`}
          >
            <Info size={16} aria-hidden="true" />
          </ToolbarTooltip>
          <ToolbarTooltip
            type="button"
            role="switch"
            aria-checked={directionLock}
            aria-label={pair.b ? m.spectate_direction_lock() : m.overlay_follow()}
            tooltip={pair.b ? m.spectate_direction_lock() : m.overlay_follow()}
            onClick={() => setDirectionLock((locked) => !locked)}
            className={`flex size-11 items-center justify-center border p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent sm:size-7 ${directionLock ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-transparent text-app-text-secondary hover:text-app-accent"}`}
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
            className={`flex size-11 items-center justify-center border p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent sm:size-7 ${tireTrails ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-transparent text-app-text-secondary hover:text-app-accent"}`}
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
            className={`flex size-11 items-center justify-center border p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent sm:size-7 ${racingLine ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-transparent text-app-text-secondary hover:text-app-accent"}`}
          >
            <Route size={16} className={hasRacingLine ? undefined : "opacity-40"} aria-hidden="true" />
          </ToolbarTooltip>
          {pair.b && <ToolbarTooltip
            type="button"
            role="switch"
            aria-checked={positionLock}
            disabled={!canLock}
            aria-label={m.spectate_position_lock()}
            tooltip={canLock ? m.spectate_position_lock() : m.spectate_position_lock_unavailable()}
            onClick={() => setPositionLockPreferred((locked) => !locked)}
            className={`flex size-11 items-center justify-center border p-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-app-accent disabled:cursor-not-allowed disabled:opacity-50 sm:size-7 ${positionLock ? "border-app-accent bg-app-accent/10 text-app-accent" : "border-transparent text-app-text-secondary hover:text-app-accent"}`}
          >
            <span className="flex items-center gap-0.5" aria-hidden="true">
              <CarFront size={10} />
              <CarFront size={10} />
            </span>
          </ToolbarTooltip>}
        </div>
      </TooltipProvider>
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
    {!error && ready && [sideAState, ...(pair.b ? [sideBState] : [])].some((state) => state.endsWith("unavailable")) && (
      <div role="status" className="absolute right-3 top-3 z-10 max-w-[16rem] rounded-sm border border-app-border bg-app-surface/90 p-2 text-app-label text-status-unavailable">
        {[sideAState, ...(pair.b ? [sideBState] : [])].map((state, index) =>
          state.endsWith("unavailable") ? (
            <p key={index}>
              {pair.b ? `${index === 0 ? "A" : "B"}: ` : ""}{state === "model-unavailable" ? m.spectate_model_unavailable() : m.spectate_pose_unavailable()}
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
); }
