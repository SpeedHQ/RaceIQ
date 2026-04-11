import type { TelemetryPacket } from "../../shared/types";
import { writeFileSync, createWriteStream } from "fs";
import { resolve } from "path";
import GifEncoder from "gif-encoder";
import sharp from "sharp";

/** Format a lap time in seconds as "m:ss.sss". */
function formatLapTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(3).padStart(6, "0");
  return `${mins}:${secs}`;
}

export interface LapGifMeta {
  lapTime?: number;
  isValid?: boolean;
  invalidReason?: string | null;
}

/**
 * Generate an animated GIF showing a lap line being drawn progressively.
 *
 * @param packets Telemetry packets for the lap
 * @param lapNumber Lap number for filename
 * @param outputDir Directory to save GIF file
 * @param recordingName Recording filename (without extension) to include in output
 * @param meta Optional lap metadata (time, validity) rendered in the top-left label
 */
export async function generateLapGif(
  packets: TelemetryPacket[],
  lapNumber: number,
  outputDir: string,
  recordingName?: string,
  meta?: LapGifMeta
): Promise<void> {
  if (packets.length < 10) return; // Need enough packets for animation

  // Find bounds
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

  // Add padding
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

  const scaleX = svgWidth / viewWidth;
  const scaleZ = svgHeight / viewHeight;

  // Create frames (every 5% of packets for smooth line growth)
  const numFrames = 20;
  const frameIntervals = Array.from({ length: numFrames }, (_, i) => Math.ceil(((i + 1) / numFrames) * packets.length));

  const gifPath = resolve(outputDir, `${recordingName ? recordingName + "-" : ""}lap-${lapNumber}.gif`);

  // Generate GIF frames (streaming to avoid memory buildup)
  return new Promise<void>(async (resolve, reject) => {
    try {
      const gif = new GifEncoder(svgWidth, svgHeight);
      const output = createWriteStream(gifPath);

      gif.pipe(output);
      gif.setDelay(150); // 150ms per frame (50% slower)
      gif.setDispose(2);
      gif.writeHeader();

      // Add frames one by one (streaming)
      for (let frameIdx = 0; frameIdx < frameIntervals.length; frameIdx++) {
        const numPackets = frameIntervals[frameIdx];
        const framePackets = packets.slice(0, numPackets);

        // Create polyline for this frame
        const pathPoints = framePackets.map((p) => {
          const x = (p.PositionX - viewMinX) * scaleX;
          const z = (viewMaxZ - p.PositionZ) * scaleZ;
          return `${x.toFixed(2)},${z.toFixed(2)}`;
        });

        const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <defs>
    <style>
      .track-path { fill: none; stroke: #3b82f6; stroke-width: 2; }
      .grid { stroke: #e5e7eb; stroke-width: 0.5; }
      .label { font-family: monospace; font-size: 12px; fill: #666; }
    </style>
  </defs>

  <!-- Grid -->
  <rect width="${svgWidth}" height="${svgHeight}" fill="white" />
  <line class="grid" x1="0" y1="0" x2="${svgWidth}" y2="0" />
  <line class="grid" x1="0" y1="0" x2="0" y2="${svgHeight}" />
  <line class="grid" x1="${svgWidth}" y1="0" x2="${svgWidth}" y2="${svgHeight}" />
  <line class="grid" x1="0" y1="${svgHeight}" x2="${svgWidth}" y2="${svgHeight}" />

  <!-- Lap path -->
  <polyline class="track-path" points="${pathPoints.join(" ")}" />

  <!-- Labels -->
  <text class="label" x="10" y="20">Lap ${lapNumber}</text>
  ${meta?.lapTime !== undefined ? `<text class="label" x="10" y="35">Time: ${formatLapTime(meta.lapTime)}</text>` : ""}
  ${meta?.isValid !== undefined ? `<text class="label" x="10" y="50" fill="${meta.isValid ? "#10b981" : "#ef4444"}">${meta.isValid ? "valid" : `invalid${meta.invalidReason ? ` (${meta.invalidReason})` : ""}`}</text>` : ""}
  <text class="label" x="10" y="70">Progress: ${numPackets}/${packets.length} packets</text>
</svg>`;

        // Convert SVG to raw RGBA buffer via sharp
        const rgbaBuffer = await sharp(Buffer.from(svg))
          .raw()
          .toBuffer();

        gif.addFrame(rgbaBuffer);
      }

      gif.finish();

      output.on("finish", () => resolve());
      output.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Generate an animated GIF showing raw telemetry data being drawn progressively.
 *
 * @param packets All telemetry packets from the recording
 * @param outputDir Directory to save GIF file
 */
export async function generateRawGif(
  packets: TelemetryPacket[],
  outputDir: string
): Promise<void> {
  if (packets.length < 10) return; // Need enough packets for animation

  // Find bounds
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

  // Add padding
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

  const scaleX = svgWidth / viewWidth;
  const scaleZ = svgHeight / viewHeight;

  // Create frames (every 5% of packets for smooth line growth)
  const numFrames = 20;
  const frameIntervals = Array.from({ length: numFrames }, (_, i) => Math.ceil(((i + 1) / numFrames) * packets.length));

  const gifPath = resolve(outputDir, `raw.gif`);

  // Generate GIF frames (streaming to avoid memory buildup)
  return new Promise<void>(async (resolve, reject) => {
    try {
      const gif = new GifEncoder(svgWidth, svgHeight);
      const output = createWriteStream(gifPath);

      gif.pipe(output);
      gif.setDelay(225); // 225ms per frame (20 frames total = ~4.5s, 3x slower)
      gif.setDispose(2);
      gif.writeHeader();

      // Add frames one by one (streaming)
      for (let frameIdx = 0; frameIdx < frameIntervals.length; frameIdx++) {
        const numPackets = frameIntervals[frameIdx];
        const framePackets = packets.slice(0, numPackets);

        // Create polyline for this frame
        const pathPoints = framePackets.map((p) => {
          const x = (p.PositionX - viewMinX) * scaleX;
          const z = (viewMaxZ - p.PositionZ) * scaleZ;
          return `${x.toFixed(2)},${z.toFixed(2)}`;
        });

        const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">
  <defs>
    <style>
      .track-path { fill: none; stroke: #3b82f6; stroke-width: 2; }
      .grid { stroke: #e5e7eb; stroke-width: 0.5; }
      .label { font-family: monospace; font-size: 12px; fill: #666; }
    </style>
  </defs>

  <!-- Grid -->
  <rect width="${svgWidth}" height="${svgHeight}" fill="white" />
  <line class="grid" x1="0" y1="0" x2="${svgWidth}" y2="0" />
  <line class="grid" x1="0" y1="0" x2="0" y2="${svgHeight}" />
  <line class="grid" x1="${svgWidth}" y1="0" x2="${svgWidth}" y2="${svgHeight}" />
  <line class="grid" x1="0" y1="${svgHeight}" x2="${svgWidth}" y2="${svgHeight}" />

  <!-- Raw telemetry path -->
  <polyline class="track-path" points="${pathPoints.join(" ")}" />

  <!-- Labels -->
  <text class="label" x="10" y="20">Raw Telemetry</text>
  <text class="label" x="10" y="40">Progress: ${numPackets}/${packets.length} packets</text>
</svg>`;

        // Convert SVG to raw RGBA buffer via sharp
        const rgbaBuffer = await sharp(Buffer.from(svg))
          .raw()
          .toBuffer();

        gif.addFrame(rgbaBuffer);
      }

      gif.finish();

      output.on("finish", () => resolve());
      output.on("error", reject);
    } catch (err) {
      reject(err);
    }
  });
}
