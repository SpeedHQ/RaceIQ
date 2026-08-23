import type { SemanticAnalysisFrame } from "../analyse/track-map/types";
import { semanticNumber } from "../analyse/track-map/types";
import { useEffect, useMemo, useRef, useState } from "react";
import type { LiveTelemetryView } from "../../lib/live-telemetry-view";
import type { ExperimentGameId } from "../../hooks/experiments";
import { useTrackBoundaries, useTrackOutline } from "../../hooks/track-queries";
import { useTelemetryStore } from "../../stores/telemetry";
import { AnalyseTrackPanel } from "../analyse/AnalyseTrackPanel";
import type { Point } from "../analyse/track-map/types";
import { CurrentLapTireStrip } from "./CurrentLapTireStrip";
import { LiveIssuesFeed } from "./LiveIssuesFeed";
import { LiveLapCards } from "./LiveLapCards";
import { LiveLapInfo } from "./LiveLapInfo";

function viewToSemanticFrame(view: LiveTelemetryView): SemanticAnalysisFrame {
  const temperature = view.tires.temperatureC;
  const pressure = view.tires.pressurePsi;
  const brakeTemperature = view.tires.brakeTemperatureC;
  const wear = view.tires.wear;
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
      "tire.temperature.average": temperature && [temperature.fl, temperature.fr, temperature.rl, temperature.rr],
      "tires.tire-pressure": pressure && [pressure.fl, pressure.fr, pressure.rl, pressure.rr],
      "brakes.brake-temp": brakeTemperature && [brakeTemperature.fl, brakeTemperature.fr, brakeTemperature.rl, brakeTemperature.rr],
      "tires.tire-wear": wear && [wear.fl, wear.fr, wear.rl, wear.rr],
      "fuel.amount": view.fuel.amount,
    },
    states: view.stateBySemanticId,
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
  if (!view || view.simulator === "f1-2025") return null;
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
export function LiveTestDashboard({ gameId, trackOrdinal }: { gameId: ExperimentGameId; trackOrdinal: number | null }) {
  const telemetryView = useTelemetryStore((s) => s.telemetryView);
  const sessionLaps = useTelemetryStore((s) => s.sessionLaps);
  const sectors = useTelemetryStore((s) => s.sectors);

  // Most-recently-completed lap's track ordinal, used as a fallback below.
  const latestLap = useMemo(() => (sessionLaps.length ? [...sessionLaps].sort((a, b) => b.lapNumber - a.lapNumber)[0] : null), [sessionLaps]);

  const [rotateWithCar, setRotateWithCar] = useState(false);
  const [trackOverlay, setTrackOverlay] = useState<"none" | "inputs" | "segments" | "sectors">("none");
  const [mapZoom, setMapZoom] = useState(1);

  // Live driving line for current in-progress lap: append each semantic view,
  // reset when a new lap starts. Capped defensively for very long laps.
  const [liveTrace, setLiveTrace] = useState<SemanticAnalysisFrame[]>([]);
  const lastFrameRef = useRef<string | null>(null);
  useEffect(() => {
    if (!telemetryView) {
      lastFrameRef.current = null;
      return;
    }
    const frameKey = `${telemetryView.streamId}:${telemetryView.sequence}`;
    if (frameKey === lastFrameRef.current) return;
    lastFrameRef.current = frameKey;
    const frame = viewToSemanticFrame(telemetryView);
    setLiveTrace((previous) => {
      const previousLap = previous.length ? semanticNumber(previous.at(-1), "timing.current-lap") : null;
      const currentLap = semanticNumber(frame, "timing.current-lap");
      const reset = previousLap != null && currentLap != null && currentLap < previousLap;
      const next = reset ? [frame] : [...previous, frame];
      return next.length > MAX_LIVE_TRACE ? next.slice(next.length - MAX_LIVE_TRACE) : next;
    });
  }, [telemetryView]);

  const semanticTrace = liveTrace;
  const currentFrame = semanticTrace.at(-1) ?? null;
  const trackOrd = trackOrdinal ?? latestLap?.trackOrdinal ?? telemetryView?.identity.trackOrdinal ?? null;
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
          <LiveLapInfo sectors={sectors} currentLap={telemetryView?.timing.currentLapS ?? null} totalLaps={sessionLaps.length} />
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
          <LiveLapCards laps={sessionLaps} trackOrdinal={trackOrd ?? undefined} sectors={sectors} currentLapNumber={telemetryView?.timing.lapNumber ?? null} maxLaps={30} />
        </div>
        {/* compact live tyre readout for the in-progress lap — sector-by-sector
            breakdown reviews a completed lap, not what's happening right now */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-3 pt-2 pb-1 text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">This Test — Tyres &amp; Fuel</div>
          <CurrentLapTireStrip telemetry={semanticTrace} />
        </div>
      </div>
    </div>
  );
}
