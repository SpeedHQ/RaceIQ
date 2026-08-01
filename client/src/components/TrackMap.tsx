import { hasWorldPositions, LAP_PATH_SEMANTIC_IDS, type LapPathSemanticId, type LapPathSemanticReader, lapPath } from "@shared/lib/lap-path";
import { TELEMETRY_CATALOG } from "@shared/telemetry-catalog";
import { compileTelemetryResolver, type SemanticSlot, type TelemetryFrameView } from "@shared/telemetry-resolver";
import type { GameId, TelemetryPacket } from "@shared/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TRACK_SPEED_COLOR_VARS } from "@/lib/colors";
import { getSemanticCanvasContext } from "@/lib/rendering/css-canvas";
import { mixCssColors } from "@/lib/rendering/css-values";
import { m } from "@/paraglide/messages";
import { client } from "../lib/rpc";
import { useGameId } from "../stores/game";

interface Point {
  x: number;
  z: number;
}

interface BoundaryData {
  leftEdge: Point[];
  rightEdge: Point[];
  centerLine: Point[];
  pitLane: Point[] | null;
  coordSystem: string;
}

interface Props {
  telemetry: TelemetryPacket[];
  colorBy?: "speed" | "throttle" | "brake";
  highlightDistance?: number;
  lineColor?: string; // optional override color (for overlay mode)
  className?: string;
  trackOrdinal?: number; // when provided, fetches and draws track boundaries
}

const TRACK_MAP_SEMANTIC_IDS = [...LAP_PATH_SEMANTIC_IDS, "inputs.accel", "inputs.brake", "timing.distance-traveled"] as const;

type TrackMapSemanticId = LapPathSemanticId | "inputs.accel" | "inputs.brake" | "timing.distance-traveled";

function getSpeedMph(packet: TelemetryPacket, reader?: LapPathSemanticReader<TrackMapSemanticId>): number {
  const resolvedSpeed = reader?.readNumber(packet, "motion.speed");
  const speedMps = resolvedSpeed ?? Math.sqrt(packet.VelocityX ** 2 + packet.VelocityY ** 2 + packet.VelocityZ ** 2);
  return speedMps * 2.23694;
}

function compileTrackMapSemanticReader(simulator: GameId): LapPathSemanticReader<TrackMapSemanticId> {
  const resolver = compileTelemetryResolver<TelemetryPacket>(TELEMETRY_CATALOG, {
    simulator,
    requested: TRACK_MAP_SEMANTIC_IDS.map((semanticId) => ({ semanticId })),
  });
  const slots = {
    "motion.position-x": resolver.slot("motion.position-x"),
    "motion.position-z": resolver.slot("motion.position-z"),
    "motion.speed": resolver.slot("motion.speed"),
    "motion.velocity-x": resolver.slot("motion.velocity-x"),
    "motion.velocity-z": resolver.slot("motion.velocity-z"),
    "motion.yaw": resolver.slot("motion.yaw"),
    "timing.lap-fraction": resolver.slot("timing.lap-fraction"),
    "inputs.accel": resolver.slot("inputs.accel"),
    "inputs.brake": resolver.slot("inputs.brake"),
    "timing.distance-traveled": resolver.slot("timing.distance-traveled"),
  } satisfies Record<TrackMapSemanticId, SemanticSlot>;
  let frameView: TelemetryFrameView | undefined;
  let currentPacket: TelemetryPacket | undefined;

  return {
    readNumber(packet, semanticId) {
      if (packet !== currentPacket || !frameView) {
        frameView = resolver.createFrameView(packet, packet.TimestampMS, frameView);
        currentPacket = packet;
      }
      return frameView.readNumber(slots[semanticId]);
    },
  };
}

function speedToColor(speed: number, minSpeed: number, maxSpeed: number): string {
  const t = Math.min(1, Math.max(0, maxSpeed > minSpeed ? (speed - minSpeed) / (maxSpeed - minSpeed) : 0));
  const [from, to, amount] = t < 0.5 ? [TRACK_SPEED_COLOR_VARS[0], TRACK_SPEED_COLOR_VARS[1], t * 2] : [TRACK_SPEED_COLOR_VARS[1], TRACK_SPEED_COLOR_VARS[2], (t - 0.5) * 2];
  return mixCssColors(from, to, amount);
}

function channelToColor(value: number, min: number, max: number): string {
  return speedToColor(value, min, max);
}

export function TrackMap({ telemetry, colorBy = "speed", highlightDistance, lineColor, className, trackOrdinal }: Props) {
  const gameId = useGameId();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [boundaries, setBoundaries] = useState<BoundaryData | null>(null);
  const simulator = telemetry[0]?.gameId ?? gameId;
  const semanticReader = useMemo(() => (simulator ? compileTrackMapSemanticReader(simulator) : undefined), [simulator]);

  // Fetch boundaries when trackOrdinal is provided
  useEffect(() => {
    if (!trackOrdinal) {
      setBoundaries(null);
      return;
    }
    if (!gameId) return;
    client.api["track-boundaries"][":ordinal"]
      .$get({ param: { ordinal: String(trackOrdinal) }, query: { gameId: gameId ?? undefined } })
      .then((r) => r.json() as unknown as BoundaryData)
      .then((data) => setBoundaries(data))
      .catch(() => setBoundaries(null));
  }, [trackOrdinal, gameId]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || telemetry.length < 2) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;

    const ctx = getSemanticCanvasContext(canvas);
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = rect.height;
    ctx.clearRect(0, 0, w, h);

    // Use Forza world positions when available, otherwise integrate from velocity
    const useWorld = hasWorldPositions(telemetry, semanticReader);
    const { x, z } = lapPath(telemetry, undefined, semanticReader);

    // Compute bounds — include boundary edges if in same coord system
    const hasBounds = boundaries && (boundaries.coordSystem === "forza" || boundaries.coordSystem === "f1-2025" || boundaries.coordSystem === "acc") && useWorld;
    let minX = Infinity,
      maxX = -Infinity,
      minZ = Infinity,
      maxZ = -Infinity;

    const allPointSets: { x: number; z: number }[][] = [x.map((xi, i) => ({ x: xi, z: z[i] }))];
    if (hasBounds) {
      allPointSets.push(boundaries!.leftEdge, boundaries!.rightEdge);
    }
    for (const pts of allPointSets) {
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
      }
    }

    const rangeX = maxX - minX || 1;
    const rangeZ = maxZ - minZ || 1;
    const padding = 20;
    const scaleX = (w - padding * 2) / rangeX;
    const scaleZ = (h - padding * 2) / rangeZ;
    const scale = Math.min(scaleX, scaleZ);

    const offsetX = (w - rangeX * scale) / 2;
    const offsetZ = (h - rangeZ * scale) / 2;

    // All games normalized to same coord convention server-side.
    // X is flipped for display so right in-game = right on screen.
    const toScreenX = useWorld ? (px: number) => offsetX + (maxX - px) * scale : (px: number) => (px - minX) * scale + offsetX;
    const toScreenZ = (pz: number) => (pz - minZ) * scale + offsetZ;

    // Draw boundary surface
    if (hasBounds) {
      const left = boundaries!.leftEdge;
      const right = boundaries!.rightEdge;

      // Filled track surface
      ctx.beginPath();
      ctx.moveTo(toScreenX(left[0].x), toScreenZ(left[0].z));
      for (let i = 1; i < left.length; i++) {
        ctx.lineTo(toScreenX(left[i].x), toScreenZ(left[i].z));
      }
      for (let i = right.length - 1; i >= 0; i--) {
        ctx.lineTo(toScreenX(right[i].x), toScreenZ(right[i].z));
      }
      ctx.closePath();
      ctx.fillStyle = "color-mix(in srgb, var(--track-surface) 25%, transparent)";
      ctx.fill();

      // Edge lines
      ctx.strokeStyle = "color-mix(in srgb, var(--track-edge) 35%, transparent)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(toScreenX(left[0].x), toScreenZ(left[0].z));
      for (let i = 1; i < left.length; i++) ctx.lineTo(toScreenX(left[i].x), toScreenZ(left[i].z));
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(toScreenX(right[0].x), toScreenZ(right[0].z));
      for (let i = 1; i < right.length; i++) ctx.lineTo(toScreenX(right[i].x), toScreenZ(right[i].z));
      ctx.stroke();

      // Center-line (faint)
      if (boundaries!.centerLine?.length > 2) {
        ctx.beginPath();
        ctx.strokeStyle = "color-mix(in srgb, var(--track-muted) 30%, transparent)";
        ctx.lineWidth = 1;
        ctx.moveTo(toScreenX(boundaries!.centerLine[0].x), toScreenZ(boundaries!.centerLine[0].z));
        for (let i = 1; i < boundaries!.centerLine.length; i++) {
          ctx.lineTo(toScreenX(boundaries!.centerLine[i].x), toScreenZ(boundaries!.centerLine[i].z));
        }
        ctx.lineTo(toScreenX(boundaries!.centerLine[0].x), toScreenZ(boundaries!.centerLine[0].z));
        ctx.stroke();
      }
    }

    // Get color channel values
    let values: number[] = [];
    if (!lineColor) {
      if (colorBy === "speed") {
        values = telemetry.map((packet) => getSpeedMph(packet, semanticReader));
      } else if (colorBy === "throttle") {
        values = telemetry.map((packet) => {
          const value = semanticReader?.readNumber(packet, "inputs.accel") ?? packet.Accel;
          return (value / 255) * 100;
        });
      } else {
        values = telemetry.map((packet) => {
          const value = semanticReader?.readNumber(packet, "inputs.brake") ?? packet.Brake;
          return (value / 255) * 100;
        });
      }
    }

    const minVal = values.length ? Math.min(...values) : 0;
    const maxVal = values.length ? Math.max(...values) : 1;

    // Draw lap trace
    ctx.lineWidth = 2.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let i = 1; i < x.length; i++) {
      ctx.beginPath();
      ctx.moveTo(toScreenX(x[i - 1]), toScreenZ(z[i - 1]));
      ctx.lineTo(toScreenX(x[i]), toScreenZ(z[i]));
      ctx.strokeStyle = lineColor || channelToColor(values[i], minVal, maxVal);
      ctx.stroke();
    }

    // Draw highlight dot
    if (highlightDistance !== undefined && telemetry.length > 0) {
      const distStart = semanticReader?.readNumber(telemetry[0], "timing.distance-traveled") ?? telemetry[0].DistanceTraveled;
      let closestIdx = 0;
      let closestDist = Infinity;
      for (let i = 0; i < telemetry.length; i++) {
        const distance = semanticReader?.readNumber(telemetry[i], "timing.distance-traveled") ?? telemetry[i].DistanceTraveled;
        const d = Math.abs(distance - distStart - highlightDistance);
        if (d < closestDist) {
          closestDist = d;
          closestIdx = i;
        }
      }
      ctx.beginPath();
      ctx.arc(toScreenX(x[closestIdx]), toScreenZ(z[closestIdx]), 6, 0, Math.PI * 2);
      ctx.fillStyle = "var(--app-text)";
      ctx.fill();
      ctx.strokeStyle = "var(--app-bg)";
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Start/finish indicator
    if (x.length > 0) {
      ctx.beginPath();
      ctx.arc(toScreenX(x[0]), toScreenZ(z[0]), 4, 0, Math.PI * 2);
      ctx.fillStyle = "var(--track-start)";
      ctx.fill();
    }
  }, [telemetry, colorBy, highlightDistance, lineColor, boundaries, semanticReader]);

  useEffect(() => {
    draw();
    const observer = new ResizeObserver(draw);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [draw]);

  return (
    <div ref={containerRef} className={`relative w-full h-full min-h-[200px] ${className ?? ""}`}>
      {telemetry.length < 2 ? (
        <div className="absolute inset-0 flex items-center justify-center text-app-text-dim text-sm">{m.trackmap_no_position_data()}</div>
      ) : (
        <canvas ref={canvasRef} className="absolute inset-0" />
      )}
    </div>
  );
}
