import { useEffect, useMemo, useRef, useState } from "react";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";
import type { ExperimentGameId } from "../../hooks/experiments";
import { useTrackBoundaries, useTrackOutline } from "../../hooks/track-queries";
import { useTelemetryStore } from "../../stores/telemetry";
import { AnalyseTrackPanel } from "../analyse/AnalyseTrackPanel";
import type { Point } from "../analyse/track-map/types";
import { CurrentLapTireStrip } from "./CurrentLapTireStrip";
import { LiveIssuesFeed } from "./LiveIssuesFeed";
import { LiveLapCards } from "./LiveLapCards";
import { LiveLapInfo } from "./LiveLapInfo";

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
export function LiveTestDashboard({
  gameId,
  trackOrdinal,
  initialTrace,
}: {
  gameId: ExperimentGameId;
  trackOrdinal: number | null;
  /** Test/story-only: pre-seed the live trace so it renders instantly without replaying packets. */
  initialTrace?: TelemetryPacket[];
}) {
  const telemetryView = useTelemetryStore((s) => s.telemetryView);
  const packet = initialTrace?.[initialTrace.length - 1] ?? null;
  const rawPacket = packet;
  const sessionLaps = useTelemetryStore((s) => s.sessionLaps);
  const sectors = useTelemetryStore((s) => s.sectors);

  // Most-recently-completed lap's track ordinal, used as a fallback below.
  const latestLap = useMemo(() => (sessionLaps.length ? [...sessionLaps].sort((a, b) => b.lapNumber - a.lapNumber)[0] : null), [sessionLaps]);

  const [rotateWithCar, setRotateWithCar] = useState(false);
  const [trackOverlay, setTrackOverlay] = useState<"none" | "inputs" | "segments" | "sectors">("none");
  const [mapZoom, setMapZoom] = useState(1);

  // Live driving line for the current in-progress lap: append each new packet,
  // reset when a new lap starts. Capped defensively for very long laps.
  const [liveTrace, setLiveTrace] = useState<TelemetryPacket[]>(() => initialTrace ?? []);
  const lastRawRef = useRef<TelemetryPacket | null>(null);
  useEffect(() => {
    if (!rawPacket) return;
    // Guard against re-processing the same packet: if rawPacket's identity is
    // unstable across renders, appending it would set state every render and
    // trigger an infinite update loop ("Maximum update depth exceeded").
    if (rawPacket === lastRawRef.current) return;
    lastRawRef.current = rawPacket;
    setLiveTrace((prev) => {
      if (prev.length && rawPacket.CurrentLap < prev[prev.length - 1].CurrentLap) {
        return [rawPacket];
      }
      const next = prev.length ? [...prev, rawPacket] : [rawPacket];
      return next.length > MAX_LIVE_TRACE ? next.slice(next.length - MAX_LIVE_TRACE) : next;
    });
  }, [rawPacket]);

  const trackOrd = trackOrdinal ?? latestLap?.trackOrdinal ?? telemetryView?.identity.trackOrdinal ?? rawPacket?.TrackOrdinal ?? null;
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
              telemetry={liveTrace}
              cursorIdx={liveTrace.length - 1}
              outline={outline}
              boundaries={boundaries}
              sectors={null}
              segments={null}
              currentPacket={rawPacket ?? null}
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
            <LiveTrackConditions view={telemetryView} />
          </div>
        </div>
        <div className="overflow-y-auto border-app-border @5xl/workspace:border-r">
          <LiveLapInfo sectors={sectors} currentLap={telemetryView?.timing.currentLapS ?? packet?.CurrentLap ?? null} totalLaps={sessionLaps.length} />
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
          <LiveLapCards laps={sessionLaps} trackOrdinal={trackOrd ?? undefined} sectors={sectors} currentLapNumber={rawPacket?.LapNumber ?? null} maxLaps={30} />
        </div>
        {/* compact live tyre readout for the in-progress lap — sector-by-sector
            breakdown reviews a completed lap, not what's happening right now */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="px-3 pt-2 pb-1 text-app-compact font-semibold text-app-text-muted uppercase tracking-wider">This Test — Tyres &amp; Fuel</div>
          <CurrentLapTireStrip telemetry={liveTrace} />
        </div>
      </div>
    </div>
  );
}
