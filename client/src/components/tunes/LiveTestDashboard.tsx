import type { SemanticAnalysisFrame } from "../analyse/track-map/types";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveTelemetryView } from "../../lib/live-telemetry-view";
import type { ExperimentGameId } from "../../hooks/experiments";
import { useTrackBoundaries, useTrackOutline } from "../../hooks/track-queries";
import { useTelemetryStore } from "../../stores/telemetry";
import { semanticTuneSampleFromView } from "./semantic-tune";
import { AnalyseTrackPanel } from "../analyse/AnalyseTrackPanel";
import type { Point } from "../analyse/track-map/types";
import { CurrentLapTireStrip } from "./CurrentLapTireStrip";
import { LiveIssuesFeed } from "./LiveIssuesFeed";
import { LiveLapCards } from "./LiveLapCards";
import { LiveLapInfo } from "./LiveLapInfo";

function viewToSemanticFrame(view: LiveTelemetryView): SemanticAnalysisFrame {
  return {
    values: {
      "identity.track-ordinal": view.identity.trackOrdinal,
      "identity.car-ordinal": view.identity.carOrdinal,
      "motion.position-x": view.motion.position?.x,
      "motion.position-z": view.motion.position?.z,
      "motion.speed": view.motion.speedMps,
      "motion.yaw": view.motion.attitude?.yaw,
      "motion.pitch": view.motion.attitude?.pitch,
      "motion.roll": view.motion.attitude?.roll,
      "inputs.accel": view.inputs.throttle,
      "inputs.brake": view.inputs.brake,
      "inputs.steer": view.inputs.steer,
      "inputs.gear": view.inputs.gear,
      "timing.distance-traveled": view.motion.distanceM,
      "timing.current-lap": view.timing.currentLapS,
      "tire.temperature.average": view.tires.temperatureC && [view.tires.temperatureC.fl, view.tires.temperatureC.fr, view.tires.temperatureC.rl, view.tires.temperatureC.rr],
    },
    states: {},
    freshness: {},
  };
}

const MAX_LIVE_TRACE = 5000;

const WEATHER_LABELS: Record<number, string> = {
  0: "Clear",
  1: "Light Cloud",
  2: "Overcast",
  3: "Light Rain",
  4: "Heavy Rain",
  5: "Storm",
};

/** Top-level track conditions from catalog-resolved semantic telemetry. */
export function LiveTrackConditions({ view }: { view: LiveTelemetryView | null | undefined }) {
  if (!view) return null;
  const weather = view.weather;
  if (weather.kind == null && weather.trackTemperatureC == null && weather.airTemperatureC == null) return null;
  return (
    <div className="absolute bottom-2 right-2 bg-app-surface-alt/80 backdrop-blur border border-app-border-input/50 rounded-lg px-2.5 py-1.5 text-app-caption space-y-0.5">
      {weather.kind != null && <div className="text-app-text font-medium">{WEATHER_LABELS[weather.kind] ?? "Unknown"}</div>}
      {(weather.trackTemperatureC != null || weather.airTemperatureC != null) && (
        <div className="flex gap-3 text-app-text-muted">
          {weather.trackTemperatureC != null && <span>Track {weather.trackTemperatureC.toFixed(0)}°C</span>}
          {weather.airTemperatureC != null && <span>Air {weather.airTemperatureC.toFixed(0)}°C</span>}
        </div>
      )}
    </div>
  );
}

/**
 * LiveTestDashboard — the "live" phase of the Setup Engineer test workflow:
 * watch a stint happen (track position, status strip, recorded laps so far),
 * rather than reviewing it after the fact. Rendered only once the driver has
 * clicked "Start Test" in ExperimentWorkspace; that parent owns the
 * Start/End Test buttons.
 */
export function LiveTestDashboard({
  gameId,
  trackOrdinal,
  initialViews,
}: {
  gameId: ExperimentGameId;
  trackOrdinal: number | null;
  /** Story-only canonical trace for immediate rendering. */
  initialViews?: LiveTelemetryView[];
}) {
  const telemetryView = useTelemetryStore((state) => state.telemetryView);
  const currentView = telemetryView ?? initialViews?.at(-1) ?? null;
  const sessionLaps = useTelemetryStore((s) => s.sessionLaps);
  const sectors = useTelemetryStore((s) => s.sectors);

  // Most-recently-completed lap's track ordinal, used as a fallback below.
  const latestLap = useMemo(() => (sessionLaps.length ? [...sessionLaps].sort((a, b) => b.lapNumber - a.lapNumber)[0] : null), [sessionLaps]);

  const [rotateWithCar, setRotateWithCar] = useState(false);
  const [trackOverlay, setTrackOverlay] = useState<"none" | "inputs" | "segments" | "sectors">("none");
  const [mapZoom, setMapZoom] = useState(1);

  // Canonical live trace for the in-progress lap.
  const [viewTrace, setViewTrace] = useState<LiveTelemetryView[]>(() => initialViews ?? []);
  const lastViewRef = useRef<LiveTelemetryView | null>(initialViews?.at(-1) ?? null);
  useEffect(() => {
    if (!telemetryView) return;
    const previous = lastViewRef.current;
    if (previous?.streamId === telemetryView.streamId && previous.sequence === telemetryView.sequence) return;
    lastViewRef.current = telemetryView;
    setViewTrace((current) => {
      const prior = current.at(-1);
      const streamChanged = prior !== undefined && prior.streamId !== telemetryView.streamId;
      const lapChanged = prior?.timing.lapNumber !== undefined && telemetryView.timing.lapNumber !== undefined && prior.timing.lapNumber !== telemetryView.timing.lapNumber;
      const next = streamChanged || lapChanged ? [telemetryView] : [...current, telemetryView];
      return next.length > MAX_LIVE_TRACE ? next.slice(next.length - MAX_LIVE_TRACE) : next;
    });
  }, [telemetryView]);
  const activeViews = viewTrace.length > 0 ? viewTrace : currentView ? [currentView] : [];
  const semanticTrace = useMemo(() => activeViews.map(viewToSemanticFrame), [activeViews]);
  const tuneTrace = useMemo(() => activeViews.map(semanticTuneSampleFromView), [activeViews]);
  const currentFrame = semanticTrace.at(-1) ?? null;

  const trackOrd = trackOrdinal ?? latestLap?.trackOrdinal ?? currentView?.identity.trackOrdinal ?? null;
  const { data: outlineRaw } = useTrackOutline(trackOrd ?? undefined, gameId);
  const outline = useMemo(() => {
    if (!outlineRaw) return null;
    const d = outlineRaw as any;
    if (d?.points && Array.isArray(d.points)) return d.points as Point[];
    if (Array.isArray(d)) return d as Point[];
    return null;
  }, [outlineRaw]);
  const { data: boundariesRaw } = useTrackBoundaries(trackOrd ?? undefined, gameId);
  const boundaries = (boundariesRaw as any) ?? null;

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Top row: live track position + car vitals + lap info */}
      <div className="grid shrink-0 grid-cols-1 border-b border-app-border @5xl/workspace:grid-cols-[1.8fr_1.5fr_1.3fr]">
        <div className="flex flex-col border-app-border @5xl/workspace:border-r">
          <div className="px-3 pt-2 pb-1 text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Track Position</div>
          <div className="relative h-[22.5rem]">
            <AnalyseTrackPanel
              gameId={gameId}
              telemetry={semanticTrace}
              cursorIdx={semanticTrace.length - 1}
              outline={outline}
              boundaries={boundaries}
              sectors={null}
              segments={null}
              currentFrame={currentFrame}
              showTrace={false}
              rotateWithCar={rotateWithCar}
              trackOverlay={trackOverlay}
              mapZoom={mapZoom}
              onRotateWithCarToggle={() => setRotateWithCar((r) => !r)}
              onTrackOverlayCycle={() => setTrackOverlay((v) => (v === "none" ? "inputs" : v === "inputs" ? "segments" : v === "segments" ? "sectors" : "none"))}
              onMapZoomChange={setMapZoom}
              hideSteeringOverlay
              weatherBottomRight
            />
          </div>
        </div>
        <div className="overflow-y-auto border-app-border @5xl/workspace:border-r">
          <LiveLapInfo sectors={sectors} currentLap={currentView?.timing.lapNumber ?? null} totalLaps={sessionLaps.length} />
        </div>
        <div className="h-full min-h-0">
          <LiveIssuesFeed />
        </div>
      </div>

      {/* Bottom: full-width — lap cards, then the live tyre strip + fuel section */}
      <div className="flex-1 min-h-0 flex flex-col">
        {/* recorded laps so far, as a card row, with the in-progress lap leading */}
        <div className="shrink-0 border-b border-app-border">
          <div className="px-3 pt-2 pb-1 text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">Laps</div>
          <LiveLapCards laps={sessionLaps} trackOrdinal={trackOrd ?? undefined} sectors={sectors} currentLapNumber={currentView?.timing.lapNumber ?? null} maxLaps={30} />
        </div>
        {/* compact live tyre readout for the in-progress lap — sector-by-sector
            breakdown reviews a completed lap, not what's happening right now */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-3 pt-2 pb-1 text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">This Test — Tyres &amp; Fuel</div>
          <CurrentLapTireStrip telemetry={tuneTrace} />
        </div>
      </div>
    </div>
  );
}
