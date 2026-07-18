import "./index.css";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AnalyseTrackMap, type TrackMapHandle, type Point } from "./components/analyse/AnalyseTrackMap";
import type { TelemetryPacket } from "@shared/types";

const TOTAL_FRAMES = 396;

function parseCsv(text: string): TelemetryPacket[] {
  const lines = text.split("\n");
  const headers = lines[0].split(",");
  const packets: TelemetryPacket[] = [];
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    const vals = lines[i].split(",");
    const obj: Record<string, unknown> = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = Number(vals[j]);
    }
    packets.push(obj as unknown as TelemetryPacket);
  }
  return packets;
}

function Capture() {
  const [telemetry, setTelemetry] = useState<TelemetryPacket[] | null>(null);
  const [boundaries, setBoundaries] = useState<{
    leftEdge: Point[];
    rightEdge: Point[];
    centerLine: Point[];
    pitLane: Point[] | null;
    coordSystem: string;
  } | null>(null);
  const ref = useRef<TrackMapHandle>(null);

  useEffect(() => {
    (async () => {
      const [csvText, boundsJson] = await Promise.all([
        fetch("/demo-lap.csv").then((r) => r.text()),
        fetch("/spa-530-boundaries.json").then((r) => r.json()),
      ]);
      setTelemetry(parseCsv(csvText));
      setBoundaries({
        leftEdge: boundsJson.leftEdge,
        rightEdge: boundsJson.rightEdge,
        centerLine: [],
        pitLane: null,
        coordSystem: "fm-2023",
      });
    })();
  }, []);

  useEffect(() => {
    if (!telemetry) return;
    const w = window as unknown as Record<string, unknown>;
    w.__totalFrames = TOTAL_FRAMES;
    // Match the angle-clip capture window: DEMO_START_FRAME=28% DEMO_MAX_FRAMES=400,
    // i.e. start at 28% into the telemetry and step 1:1 through the following frames
    // (see vendor/raceiq/playwright/record-demo.spec.ts + Onboarding.tsx __setFrame).
    const startFrame = Math.floor(0.28 * telemetry.length);
    w.__setFrame = (frame: number) => {
      const idx = startFrame + frame;
      ref.current?.updateCursor(Math.max(0, Math.min(telemetry.length - 1, idx)));
    };
    // Draw first frame immediately and signal readiness
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        (w.__setFrame as (n: number) => void)(0);
        w.__captureReady = true;
      });
    });
  }, [telemetry, boundaries]);

  if (!telemetry) return null;

  return (
    <div style={{ width: 440, height: 440, background: "#05090d" }}>
      <AnalyseTrackMap
        ref={ref}
        telemetry={telemetry}
        cursorIdx={0}
        outline={null}
        boundaries={boundaries}
        sectors={null}
        segments={null}
        highlights={null}
        showInputs={false}
        rotateWithCar={false}
        zoom={0.85}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Capture />);
