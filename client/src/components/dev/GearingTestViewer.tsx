import type {
  LiveTelemetryFrameMessageV1,
  LiveTelemetrySchemaMessageV1,
} from "@shared/telemetry/live/contracts";
import { WATTS_PER_HORSEPOWER } from "@shared/games/telemetry";
import { useEffect, useMemo, useState } from "react";
import { Label } from "@/components/ui/label";
import { viewToGearingSample } from "../../hooks/useGearingIngest";
import { useUnits } from "../../hooks/useUnits";
import { findBestShiftRpm, findVisualCrossing } from "../../lib/gearing-ratios";
import {
  buildLiveTelemetryView,
  type LiveTelemetryView,
} from "../../lib/live-telemetry-view";
import { computeGearingState, computeTrackLaps } from "../../lib/session-gearing";
import type { GearingSample } from "../../lib/gearing-telemetry";
import { GearRatioCharts } from "../telemetry/GearRatioCharts";
import { PowerBandChart } from "../telemetry/PowerBandChart";
import { TrackSpeedChart } from "../telemetry/TrackSpeedChart";

interface E2EFile {
  name: string;
  path: string;
  size: number;
  modified: number;
}

export function GearingTestViewer() {
  const [files, setFiles] = useState<E2EFile[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [schema, setSchema] = useState<LiveTelemetrySchemaMessageV1 | null>(null);
  const [frames, setFrames] = useState<LiveTelemetryFrameMessageV1[]>([]);
  const [packetIndex, setPacketIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const units = useUnits();

  // Decode frames with the live decoder, then adapt through the live gearing
  // adapter — the exact path live telemetry takes before charting.
  const views = useMemo(() => {
    if (!schema) return [];
    const out: LiveTelemetryView[] = [];
    for (const frame of frames) {
      const view = buildLiveTelemetryView(schema, frame);
      if (view) out.push(view);
    }
    return out;
  }, [schema, frames]);

  const samples = useMemo(
    () => views
      .map((view) => viewToGearingSample(view, true))
      // Frames missing required semantics are rejected, like live ingestion.
      .filter((sample): sample is GearingSample => sample !== null),
    [views, units],
  );

  // Replay the recording at 20 fps so the scrubbed charts update realistically.
  useEffect(() => {
    if (!playing) return;
    if (packetIndex >= samples.length - 1) {
      setPlaying(false);
      return;
    }
    const id = setInterval(() => setPacketIndex((i) => Math.min(i + 1, samples.length - 1)), 50);
    return () => clearInterval(id);
  }, [playing, samples.length, packetIndex]);

  const fm23Files = useMemo(() => files.filter((f) => f.name.startsWith("fm-2023-")).sort((a, b) => b.modified - a.modified), [files]);

  const currentPacket = samples[packetIndex] ?? null;

  const gearingState = useMemo(() => {
    return computeGearingState(samples.slice(0, packetIndex + 1));
  }, [samples, packetIndex]);

  const crossRpm = useMemo(() => {
    const p = gearingState.powerCurve;
    const t = gearingState.torqueCurve;
    if (p.length < 2 || t.length < 2) return null;
    return findVisualCrossing(p, t, Math.max(...p.map((x) => x.powerW)) * 1.05, Math.max(...t.map((x) => x.nm)) * 1.05);
  }, [gearingState]);

  const trackLaps = useMemo(() => {
    return computeTrackLaps(samples.slice(0, packetIndex + 1));
  }, [samples, packetIndex]);

  useEffect(() => {
    fetch("/api/dev/e2e-files")
      .then((r) => r.json())
      .then((data) => setFiles(data.files || []))
      .catch((e) => console.error("Failed to fetch E2E files:", e));
  }, []);

  const handleSelectFile = async (filename: string) => {
    setSelectedFile(filename);
    setLoading(true);
    setFrames([]);
    setSchema(null);
    setPacketIndex(0);

    try {
      const res = await fetch(`/api/dev/e2e-telemetry/${encodeURIComponent(filename)}`);
      const data = await res.json();
      setSchema(data.schema ?? null);
      const nextFrames: LiveTelemetryFrameMessageV1[] = Array.isArray(data.frames) ? data.frames : [];
      setFrames(nextFrames);
      setPacketIndex(nextFrames.length > 0 ? nextFrames.length - 1 : 0);
    } catch (e) {
      console.error("Failed to load telemetry:", e);
      setFrames([]);
      setSchema(null);
      setPacketIndex(0);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="pb-4 border-b border-app-border mb-4">
        <h3 className="text-lg font-semibold text-app-text">FM23 Powerband Test Viewer</h3>
        <p className="text-sm text-app-text-muted mt-1">Replay FM23 recordings with powerband charts and packet scrubber</p>
      </div>

      {/* Left/Right split */}
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Left: File list */}
        <div className="w-64 shrink-0 flex flex-col">
          <Label className="text-sm font-medium mb-2">Recordings ({fm23Files.length})</Label>
          <div className="space-y-1 flex-1 overflow-y-auto border border-app-border rounded p-2 bg-app-surface-alt">
            {fm23Files.length === 0 ? (
              <p className="text-sm text-app-text-muted p-2">No FM23 recordings found</p>
            ) : (
              fm23Files.map((file) => (
                <button
                  type="button"
                  key={file.name}
                  onClick={() => handleSelectFile(file.name)}
                  className={`w-full text-left px-2 py-1 rounded text-xs transition-colors ${
                    selectedFile === file.name ? "bg-app-accent text-app-on-filled" : "bg-app-surface text-app-text hover:bg-app-surface-hover"
                  }`}
                >
                  <div className="font-mono truncate">{file.name}</div>
                  <div className="text-app-text-muted text-xs">{(file.size / 1024 / 1024).toFixed(1)} MB</div>
                </button>
              ))
            )}
          </div>
        </div>

        {/* Right: Charts and controls */}
        {selectedFile ? (
          <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {loading ? (
              <div className="flex-1 flex items-center justify-center text-app-text-muted">Loading telemetry...</div>
            ) : currentPacket ? (
              <>
                {/* Charts */}
                <div className="flex-1 overflow-auto">
                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-2 p-2">
                    <div className="lg:col-span-3 min-h-[300px]">
                      <PowerBandChart packet={currentPacket} powerCurve={gearingState.powerCurve} torqueCurve={gearingState.torqueCurve} shiftPointRpm={findBestShiftRpm(gearingState.powerCurve)} />
                    </div>
                    <div className="lg:col-span-3">
                      <TrackSpeedChart laps={trackLaps} toDistance={units.distance} toSpeed={units.speed} distanceLabel={units.distanceLabel} speedLabel={units.speedLabel} />
                    </div>
                    <div className="lg:col-span-3">
                      <GearRatioCharts packet={currentPacket} powerCurve={gearingState.powerCurve} targetMaxSpeed={0} speedLabel={units.speedLabel} crossRpm={crossRpm} />
                    </div>
                  </div>
                </div>

                {/* Scrubber */}
                <div className="shrink-0 border-t border-app-border p-4 space-y-2 bg-app-surface-alt">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm font-medium">
                      Packet: <span className="text-app-accent font-mono">{packetIndex + 1}</span>
                      <span className="text-app-text-muted ml-2">/ {samples.length}</span>
                    </Label>
                    <button
                      type="button"
                      onClick={() => setPlaying(!playing)}
                      className="px-2 py-0.5 rounded text-xs bg-app-surface-alt border border-app-border text-app-text hover:bg-app-surface-hover"
                    >
                      {playing ? "Pause" : "Play"}
                    </button>
                  </div>
                  <input type="range" min="0" max={Math.max(0, samples.length - 1)} value={packetIndex} onChange={(e) => setPacketIndex(Number(e.target.value))} className="w-full" />
                  <div className="flex gap-4 text-xs text-app-text-muted flex-wrap">
                    <span>
                      RPM: <span className="text-app-text">{currentPacket.rpm.toFixed(0)}</span>
                    </span>
                    <span>
                      Gear: <span className="text-app-text">{currentPacket.Gear}</span>
                    </span>
                    <span>
                      Speed: <span className="text-app-text">{units.speed(currentPacket.speedMps).toFixed(1)}</span>
                    </span>
                    <span>
                      Throttle: <span className="text-app-text">{currentPacket.Accel}</span>
                    </span>
                    <span>
                      Power: <span className="text-app-text">{(currentPacket.powerW / WATTS_PER_HORSEPOWER).toFixed(0)} hp</span>
                    </span>
                    <span>
                      Torque: <span className="text-app-text">{currentPacket.torqueNm.toFixed(0)} Nm</span>
                    </span>
                  </div>
                </div>
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-app-text-muted">No packets loaded</div>
            )}
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center text-app-text-muted">Select an FM23 recording to view gearing data</div>
        )}
      </div>
    </div>
  );
}
