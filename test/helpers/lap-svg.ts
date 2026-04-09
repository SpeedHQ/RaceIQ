import type { TelemetryPacket } from "../../shared/types";
import { writeFileSync } from "fs";
import { resolve } from "path";

/**
 * Generate an SVG visualization of a lap's telemetry data.
 * Plots the car's X,Z coordinates as a path on the track.
 *
 * @param packets Telemetry packets for the lap
 * @param lapNumber Lap number for filename
 * @param outputDir Directory to save SVG file
 */
export function generateLapSvg(packets: TelemetryPacket[], lapNumber: number, outputDir: string): void {
  if (packets.length === 0) return;

  // Find bounds of coordinates
  let minX = packets[0].PositionX;
  let maxX = packets[0].PositionX;
  let minZ = packets[0].PositionZ;
  let maxZ = packets[0].PositionZ;

  for (const p of packets) {
    minX = Math.min(minX, p.PositionX);
    maxX = Math.max(maxX, p.PositionX);
    minZ = Math.min(minZ, p.PositionZ);
    maxZ = Math.max(maxZ, p.PositionZ);
  }

  // Add 10% padding
  const paddingX = (maxX - minX) * 0.1 || 100;
  const paddingZ = (maxZ - minZ) * 0.1 || 100;
  const viewMinX = minX - paddingX;
  const viewMaxX = maxX + paddingX;
  const viewMinZ = minZ - paddingZ;
  const viewMaxZ = maxZ + paddingZ;

  const viewWidth = viewMaxX - viewMinX;
  const viewHeight = viewMaxZ - viewMinZ;
  const svgWidth = 800;
  const svgHeight = 600;

  // Scale to fit SVG
  const scaleX = svgWidth / viewWidth;
  const scaleZ = svgHeight / viewHeight;

  // Create path points
  const pathPoints = packets.map((p) => {
    const x = (p.PositionX - viewMinX) * scaleX;
    const z = (p.PositionZ - viewMinZ) * scaleZ;
    return `${x.toFixed(2)},${z.toFixed(2)}`;
  });

  // Build SVG
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <defs>
    <style>
      .track-path { fill: none; stroke: #3b82f6; stroke-width: 2; }
      .start-point { fill: #10b981; r: 4; }
      .end-point { fill: #ef4444; r: 4; }
      .grid { stroke: #e5e7eb; stroke-width: 0.5; }
      .label { font-family: monospace; font-size: 12px; fill: #666; }
    </style>
  </defs>

  <!-- Grid -->
  <line class="grid" x1="0" y1="0" x2="${svgWidth}" y2="0" />
  <line class="grid" x1="0" y1="0" x2="0" y2="${svgHeight}" />
  <line class="grid" x1="${svgWidth}" y1="0" x2="${svgWidth}" y2="${svgHeight}" />
  <line class="grid" x1="0" y1="${svgHeight}" x2="${svgWidth}" y2="${svgHeight}" />

  <!-- Lap path -->
  <polyline class="track-path" points="${pathPoints.join(" ")}" />

  <!-- Start point (green) -->
  <circle class="start-point" cx="${pathPoints[0].split(",")[0]}" cy="${pathPoints[0].split(",")[1]}" />

  <!-- End point (red) -->
  <circle class="end-point" cx="${pathPoints[pathPoints.length - 1].split(",")[0]}" cy="${pathPoints[pathPoints.length - 1].split(",")[1]}" />

  <!-- Labels -->
  <text class="label" x="10" y="20">Lap ${lapNumber}</text>
  <text class="label" x="10" y="40">Packets: ${packets.length}</text>
  <text class="label" x="10" y="60" font-size="10">X: ${minX.toFixed(0)}-${maxX.toFixed(0)}</text>
  <text class="label" x="10" y="75" font-size="10">Z: ${minZ.toFixed(0)}-${maxZ.toFixed(0)}</text>
</svg>`;

  const filename = resolve(outputDir, `lap-${lapNumber}.svg`);
  writeFileSync(filename, svg);
}
