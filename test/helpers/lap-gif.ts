import type { TelemetryPacket } from "../../shared/types";
import { createWriteStream } from "fs";
import { resolve } from "path";
import GifEncoder from "gif-encoder";

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

// ── Pure-JS pixel renderer (deterministic, no external rasterizer) ──

const GIF_W = 800;
const GIF_H = 600;

/** RGBA color constants */
const WHITE  = [255, 255, 255, 255] as const;
const BLUE   = [ 59, 130, 246, 255] as const;  // #3b82f6
const GRAY   = [229, 231, 235, 255] as const;  // #e5e7eb grid
const GREEN  = [ 16, 185, 129, 255] as const;  // #10b981 valid
const RED    = [239,  68,  68, 255] as const;  // #ef4444 invalid
const DKGRAY = [102, 102, 102, 255] as const;  // #666 label text

/** Fill entire buffer with a colour. */
function fillRect(buf: Uint8Array, r: number, g: number, b: number, a: number): void {
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
  }
}

/** Set a single pixel (bounds-checked). */
function setPixel(buf: Uint8Array, x: number, y: number, col: readonly [number, number, number, number]): void {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || xi >= GIF_W || yi < 0 || yi >= GIF_H) return;
  const i = (yi * GIF_W + xi) * 4;
  buf[i] = col[0]; buf[i + 1] = col[1]; buf[i + 2] = col[2]; buf[i + 3] = col[3];
}

/** Draw a line using Bresenham's algorithm (integer, no anti-aliasing). */
function drawLine(
  buf: Uint8Array,
  x0: number, y0: number,
  x1: number, y1: number,
  col: readonly [number, number, number, number],
  width = 2,
): void {
  let xi0 = Math.round(x0), yi0 = Math.round(y0);
  let xi1 = Math.round(x1), yi1 = Math.round(y1);
  const dx = Math.abs(xi1 - xi0), dy = Math.abs(yi1 - yi0);
  const sx = xi0 < xi1 ? 1 : -1, sy = yi0 < yi1 ? 1 : -1;
  let err = dx - dy;
  const r = Math.floor(width / 2);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (let oy = -r; oy <= r; oy++)
      for (let ox = -r; ox <= r; ox++)
        setPixel(buf, xi0 + ox, yi0 + oy, col);
    if (xi0 === xi1 && yi0 === yi1) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; xi0 += sx; }
    if (e2 <  dx) { err += dx; yi0 += sy; }
  }
}

/** Draw a horizontal grid line. */
function drawHLine(buf: Uint8Array, y: number, col: readonly [number, number, number, number]): void {
  drawLine(buf, 0, y, GIF_W - 1, y, col, 1);
}
/** Draw a vertical grid line. */
function drawVLine(buf: Uint8Array, x: number, col: readonly [number, number, number, number]): void {
  drawLine(buf, x, 0, x, GIF_H - 1, col, 1);
}

/**
 * Tiny 5×7 bitmap font — digits, colon, dot, slash, letters A-Z, space.
 * Each glyph is 5 columns × 7 rows packed as 7 uint8 values (1 bit per column).
 */
const FONT: Record<string, number[]> = {
  " ": [0,0,0,0,0,0,0],
  "0": [0x1f,0x11,0x11,0x11,0x11,0x11,0x1f],
  "1": [0x04,0x06,0x05,0x04,0x04,0x04,0x1f],
  "2": [0x0e,0x11,0x10,0x08,0x04,0x02,0x1f],
  "3": [0x0e,0x11,0x10,0x0c,0x10,0x11,0x0e],
  "4": [0x08,0x0c,0x0a,0x09,0x1f,0x08,0x08],
  "5": [0x1f,0x01,0x0f,0x10,0x10,0x11,0x0e],
  "6": [0x0c,0x02,0x01,0x0f,0x11,0x11,0x0e],
  "7": [0x1f,0x10,0x08,0x08,0x04,0x04,0x04],
  "8": [0x0e,0x11,0x11,0x0e,0x11,0x11,0x0e],
  "9": [0x0e,0x11,0x11,0x1e,0x10,0x08,0x06],
  ":": [0,0x04,0x04,0,0x04,0x04,0],
  ".": [0,0,0,0,0,0x04,0x04],
  "/": [0x10,0x10,0x08,0x04,0x02,0x01,0x01],
  "-": [0,0,0,0x1f,0,0,0],
  "(": [0x08,0x04,0x02,0x02,0x02,0x04,0x08],
  ")": [0x02,0x04,0x08,0x08,0x08,0x04,0x02],
  "A": [0x04,0x0a,0x11,0x11,0x1f,0x11,0x11],
  "B": [0x0f,0x11,0x11,0x0f,0x11,0x11,0x0f],
  "C": [0x0e,0x11,0x01,0x01,0x01,0x11,0x0e],
  "D": [0x07,0x09,0x11,0x11,0x11,0x09,0x07],
  "E": [0x1f,0x01,0x01,0x0f,0x01,0x01,0x1f],
  "F": [0x1f,0x01,0x01,0x0f,0x01,0x01,0x01],
  "G": [0x0e,0x11,0x01,0x1d,0x11,0x11,0x0e],
  "H": [0x11,0x11,0x11,0x1f,0x11,0x11,0x11],
  "I": [0x0e,0x04,0x04,0x04,0x04,0x04,0x0e],
  "J": [0x1c,0x08,0x08,0x08,0x08,0x09,0x06],
  "K": [0x11,0x09,0x05,0x03,0x05,0x09,0x11],
  "L": [0x01,0x01,0x01,0x01,0x01,0x01,0x1f],
  "M": [0x11,0x1b,0x15,0x11,0x11,0x11,0x11],
  "N": [0x11,0x13,0x15,0x19,0x11,0x11,0x11],
  "O": [0x0e,0x11,0x11,0x11,0x11,0x11,0x0e],
  "P": [0x0f,0x11,0x11,0x0f,0x01,0x01,0x01],
  "R": [0x0f,0x11,0x11,0x0f,0x05,0x09,0x11],
  "S": [0x0e,0x11,0x01,0x0e,0x10,0x11,0x0e],
  "T": [0x1f,0x04,0x04,0x04,0x04,0x04,0x04],
  "U": [0x11,0x11,0x11,0x11,0x11,0x11,0x0e],
  "Q": [0x0e,0x11,0x11,0x11,0x15,0x09,0x16],
  "V": [0x11,0x11,0x11,0x11,0x11,0x0a,0x04],
  "W": [0x11,0x11,0x11,0x15,0x15,0x1b,0x11],
  "X": [0x11,0x0a,0x04,0x04,0x04,0x0a,0x11],
  "Y": [0x11,0x11,0x0a,0x04,0x04,0x04,0x04],
  "Z": [0x1f,0x10,0x08,0x04,0x02,0x01,0x1f],
};

/** Draw a string at pixel position (x, y), scale 2×. */
function drawText(
  buf: Uint8Array,
  text: string,
  x: number,
  y: number,
  col: readonly [number, number, number, number],
): void {
  const scale = 2;
  let cx = x;
  for (const ch of text.toUpperCase()) {
    const glyph = FONT[ch] ?? FONT[" "]!;
    for (let row = 0; row < 7; row++) {
      const bits = glyph[row]!;
      for (let col2 = 0; col2 < 5; col2++) {
        if (bits & (1 << col2)) {
          for (let sy = 0; sy < scale; sy++)
            for (let sx = 0; sx < scale; sx++)
              setPixel(buf, cx + col2 * scale + sx, y + row * scale + sy, col);
        }
      }
    }
    cx += (5 + 1) * scale;
  }
}

/** Build one GIF frame RGBA buffer from telemetry packets. */
function buildFrame(
  packets: TelemetryPacket[],
  viewMinX: number, viewMaxX: number,
  viewMinZ: number, viewMaxZ: number,
  label: string,
  statusLine?: string,
  statusGood?: boolean,
): Uint8Array {
  const buf = new Uint8Array(GIF_W * GIF_H * 4);
  fillRect(buf, ...WHITE);

  // Border
  drawHLine(buf, 0, GRAY); drawHLine(buf, GIF_H - 1, GRAY);
  drawVLine(buf, 0, GRAY); drawVLine(buf, GIF_W - 1, GRAY);

  const viewW = viewMaxX - viewMinX;
  const viewH = viewMaxZ - viewMinZ;
  const scaleX = GIF_W / viewW;
  const scaleZ = GIF_H / viewH;

  // Draw track polyline
  let prevX: number | null = null, prevZ: number | null = null;
  for (const p of packets) {
    const px = (p.PositionX - viewMinX) * scaleX;
    const pz = (viewMaxZ - p.PositionZ) * scaleZ;
    if (prevX !== null && prevZ !== null) {
      drawLine(buf, prevX, prevZ, px, pz, BLUE, 2);
    }
    prevX = px; prevZ = pz;
  }

  // Labels
  drawText(buf, label, 10, 10, DKGRAY);
  if (statusLine) {
    drawText(buf, statusLine, 10, 32, statusGood === false ? RED : GREEN);
  }

  return buf;
}

/**
 * Generate an animated GIF showing a lap line being drawn progressively.
 */
export async function generateLapGif(
  packets: TelemetryPacket[],
  lapNumber: number,
  outputDir: string,
  recordingName?: string,
  meta?: LapGifMeta,
): Promise<void> {
  if (packets.length < 10) return;

  let minX = packets[0].PositionX, maxX = packets[0].PositionX;
  let minZ = packets[0].PositionZ, maxZ = packets[0].PositionZ;
  for (const p of packets) {
    minX = Math.min(minX, p.PositionX); maxX = Math.max(maxX, p.PositionX);
    minZ = Math.min(minZ, p.PositionZ); maxZ = Math.max(maxZ, p.PositionZ);
  }
  const padX = (maxX - minX) * 0.1 || 100, padZ = (maxZ - minZ) * 0.1 || 100;
  const vMinX = minX - padX, vMaxX = maxX + padX;
  const vMinZ = minZ - padZ, vMaxZ = maxZ + padZ;

  const numFrames = 20;
  const frameIntervals = Array.from({ length: numFrames }, (_, i) =>
    Math.ceil(((i + 1) / numFrames) * packets.length));

  const gifPath = resolve(outputDir, `${recordingName ? recordingName + "-" : ""}lap-${lapNumber}.gif`);

  const label = `LAP ${lapNumber}${meta?.lapTime !== undefined ? " " + formatLapTime(meta.lapTime) : ""}`;
  const statusLine = meta?.isValid !== undefined
    ? (meta.isValid ? "VALID" : `INVALID${meta.invalidReason ? " " + meta.invalidReason : ""}`)
    : undefined;

  return new Promise<void>((res, rej) => {
    const gif = new GifEncoder(GIF_W, GIF_H);
    const output = createWriteStream(gifPath);
    gif.pipe(output);
    gif.setDelay(150);
    gif.setDispose(2);
    gif.writeHeader();

    (async () => {
      for (const numPkts of frameIntervals) {
        const frame = buildFrame(
          packets.slice(0, numPkts),
          vMinX, vMaxX, vMinZ, vMaxZ,
          label, statusLine, meta?.isValid,
        );
        gif.addFrame(frame);
        // Yield to let the encoder drain its internal buffer between frames
        await new Promise<void>(r => setImmediate(r));
      }
      gif.finish();
    })().catch(rej);

    output.on("finish", res);
    output.on("error", rej);
  });
}

/**
 * Generate an animated GIF showing raw telemetry data being drawn progressively.
 */
export async function generateRawGif(
  packets: TelemetryPacket[],
  outputDir: string,
): Promise<void> {
  if (packets.length < 10) return;

  let minX = packets[0].PositionX, maxX = packets[0].PositionX;
  let minZ = packets[0].PositionZ, maxZ = packets[0].PositionZ;
  for (const p of packets) {
    minX = Math.min(minX, p.PositionX); maxX = Math.max(maxX, p.PositionX);
    minZ = Math.min(minZ, p.PositionZ); maxZ = Math.max(maxZ, p.PositionZ);
  }
  const padX = (maxX - minX) * 0.1 || 100, padZ = (maxZ - minZ) * 0.1 || 100;
  const vMinX = minX - padX, vMaxX = maxX + padX;
  const vMinZ = minZ - padZ, vMaxZ = maxZ + padZ;

  const numFrames = 20;
  const frameIntervals = Array.from({ length: numFrames }, (_, i) =>
    Math.ceil(((i + 1) / numFrames) * packets.length));

  const gifPath = resolve(outputDir, "raw.gif");

  return new Promise<void>((res, rej) => {
    const gif = new GifEncoder(GIF_W, GIF_H);
    const output = createWriteStream(gifPath);
    gif.pipe(output);
    gif.setDelay(225);
    gif.setDispose(2);
    gif.writeHeader();

    (async () => {
      for (const numPkts of frameIntervals) {
        const frame = buildFrame(
          packets.slice(0, numPkts),
          vMinX, vMaxX, vMinZ, vMaxZ,
          "RAW TELEMETRY",
        );
        gif.addFrame(frame);
        await new Promise<void>(r => setImmediate(r));
      }
      gif.finish();
    })().catch(rej);

    output.on("finish", res);
    output.on("error", rej);
  });
}
