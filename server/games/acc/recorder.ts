/**
 * ACC telemetry recorder and replayer.
 *
 * Records raw shared memory frames (physics + graphics + static buffers)
 * to a binary file for offline development and debugging.
 *
 * File format:
 *   Header: "ACCREC\0\0" (8 bytes magic)
 *           u32le version (4 bytes, currently 1)
 *           u32le physicsSize (4 bytes)
 *           u32le graphicsSize (4 bytes)
 *           u32le staticSize (4 bytes)
 *   Frames: [f64le timestamp (ms)] [physics buf] [graphics buf] [static buf]
 *           Each frame is 8 + physicsSize + graphicsSize + staticSize bytes.
 *
 * Replay reads frames back at original timing and feeds them through
 * parseAccBuffers → processPacket, simulating a live ACC session.
 */
import { existsSync, mkdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { PHYSICS, GRAPHICS, STATIC } from "./structs";
import { parseAccBuffers } from "./parser";
import { readWString } from "./utils";
import { processPacket } from "../../pipeline";
import { getAccCarByModel } from "../../../shared/acc-car-data";
import { getAccTrackByName } from "../../../shared/acc-track-data";

const MAGIC = Buffer.from("ACCREC\0\0", "ascii");
const VERSION = 1;
const HEADER_SIZE = 8 + 4 + 4 + 4 + 4; // magic + version + 3 sizes
const FRAME_HEADER = 8; // f64le timestamp

function defaultRecordingDir(): string {
  return resolve(process.cwd(), "data", "acc-recordings");
}

export class AccRecorder {
  private _file: Bun.FileSink | null = null;
  private _path: string | null = null;
  private _frameCount = 0;
  // @ts-ignore — written but not yet read (state tracking for future use)
  private _headerWritten = false;

  get recording(): boolean {
    return this._file !== null;
  }

  get frameCount(): number {
    return this._frameCount;
  }

  get path(): string | null {
    return this._path;
  }

  /** Start recording to a new file. Returns the file path. */
  start(dir?: string): string {
    if (this._file) this.stop();

    const outDir = dir ?? defaultRecordingDir();
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this._path = resolve(outDir, `acc-${timestamp}.bin`);
    this._file = Bun.file(this._path).writer();
    this._frameCount = 0;
    this._headerWritten = false;

    // Write header
    const header = Buffer.alloc(HEADER_SIZE);
    MAGIC.copy(header, 0);
    header.writeUInt32LE(VERSION, 8);
    header.writeUInt32LE(PHYSICS.SIZE, 12);
    header.writeUInt32LE(GRAPHICS.SIZE, 16);
    header.writeUInt32LE(STATIC.SIZE, 20);
    this._file.write(header);
    this._headerWritten = true;

    console.log(`[ACC Recorder] Recording to ${this._path}`);
    return this._path;
  }

  /** Record a single frame of raw buffers */
  writeFrame(physics: Buffer, graphics: Buffer, staticData: Buffer): void {
    if (!this._file) return;

    const ts = Buffer.alloc(FRAME_HEADER);
    ts.writeDoubleLE(Date.now(), 0);

    this._file.write(ts);
    this._file.write(physics);
    this._file.write(graphics);
    this._file.write(staticData);
    this._frameCount++;
  }

  /** Stop recording and flush to disk */
  async stop(): Promise<void> {
    if (!this._file) return;
    await this._file.end();
    console.log(`[ACC Recorder] Stopped. ${this._frameCount} frames written to ${this._path}`);
    this._file = null;
  }
}

/** Parse and validate a recording file header. Returns sizes or null if invalid. */
function readHeader(buf: Buffer): {
  physicsSize: number;
  graphicsSize: number;
  staticSize: number;
} | null {
  if (buf.length < HEADER_SIZE) return null;
  if (!buf.slice(0, 8).equals(MAGIC)) return null;

  const version = buf.readUInt32LE(8);
  if (version !== VERSION) {
    console.error(`[ACC Replay] Unsupported recording version: ${version}`);
    return null;
  }

  return {
    physicsSize: buf.readUInt32LE(12),
    graphicsSize: buf.readUInt32LE(16),
    staticSize: buf.readUInt32LE(20),
  };
}

/**
 * Read all frames from an ACC recording file.
 * Returns an array of {physics, graphics, staticData} buffer tuples.
 * A truncated final frame is silently skipped (safe after hard kill).
 */
export function readAccFrames(
  filePath: string
): { physics: Buffer; graphics: Buffer; staticData: Buffer }[] {
  const data = Buffer.from(readFileSync(filePath));
  const header = readHeader(data);
  if (!header) return [];

  const { physicsSize, graphicsSize, staticSize } = header;
  const frameSize = FRAME_HEADER + physicsSize + graphicsSize + staticSize;
  const frames: { physics: Buffer; graphics: Buffer; staticData: Buffer }[] = [];

  let offset = HEADER_SIZE;
  while (offset + frameSize <= data.length) {
    const physicsStart = offset + FRAME_HEADER;
    const graphicsStart = physicsStart + physicsSize;
    const staticStart = graphicsStart + graphicsSize;

    frames.push({
      physics: Buffer.from(data.subarray(physicsStart, graphicsStart)),
      graphics: Buffer.from(data.subarray(graphicsStart, staticStart)),
      staticData: Buffer.from(data.subarray(staticStart, staticStart + staticSize)),
    });
    offset += frameSize;
  }

  return frames;
}

/**
 * Replay a recorded ACC telemetry file.
 *
 * Reads frames from the file and feeds them through the parser → pipeline
 * at the original recording speed (or faster with speedMultiplier).
 *
 * @param filePath Path to the .bin recording file
 * @param options.speed Playback speed multiplier (default 1.0 = real-time)
 * @param options.loop Whether to loop the recording (default false)
 * @returns A stop function to cancel playback
 */
export async function replayRecording(
  filePath: string,
  options: { speed?: number; loop?: boolean } = {}
): Promise<{ stop: () => void; frameCount: number }> {
  const speed = options.speed ?? 1.0;
  const loop = options.loop ?? false;

  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    throw new Error(`Recording file not found: ${filePath}`);
  }

  const data = Buffer.from(await file.arrayBuffer());
  const header = readHeader(data);
  if (!header) {
    throw new Error(`Invalid ACC recording file: ${filePath}`);
  }

  const { physicsSize, graphicsSize, staticSize } = header;
  const frameSize = FRAME_HEADER + physicsSize + graphicsSize + staticSize;
  const frameCount = Math.floor((data.length - HEADER_SIZE) / frameSize);

  if (frameCount === 0) {
    throw new Error(`Recording file has no frames: ${filePath}`);
  }

  // Resolve car/track ordinals from first frame's static buffer
  const firstStaticOffset = HEADER_SIZE + FRAME_HEADER + physicsSize + graphicsSize;
  const firstStatic = data.slice(firstStaticOffset, firstStaticOffset + staticSize);
  const carModel = readWString(firstStatic, STATIC.carModel.offset, STATIC.carModel.size);
  const trackName = readWString(firstStatic, STATIC.track.offset, STATIC.track.size);
  const carOrdinal = getAccCarByModel(carModel)?.id ?? 0;
  const trackOrdinal = getAccTrackByName(trackName)?.id ?? 0;
  console.log(`[ACC Replay] Playing ${filePath} — ${frameCount} frames at ${speed}x (car: ${carModel} → #${carOrdinal}, track: ${trackName} → #${trackOrdinal})`);

  let cancelled = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const overrides = { carOrdinal, trackOrdinal };

  async function playFrames(): Promise<void> {
    let firstTimestamp: number | null = null;
    let playbackStart = Date.now();

    do {
      firstTimestamp = null;
      playbackStart = Date.now();

      for (let i = 0; i < frameCount; i++) {
        if (cancelled) return;

        const frameOffset = HEADER_SIZE + i * frameSize;
        const timestamp = data.readDoubleLE(frameOffset);

        if (firstTimestamp === null) {
          firstTimestamp = timestamp;
        }

        // Wait for correct timing relative to playback start
        const recordedElapsed = timestamp - firstTimestamp;
        const targetElapsed = recordedElapsed / speed;
        const actualElapsed = Date.now() - playbackStart;
        const delay = targetElapsed - actualElapsed;

        if (delay > 1) {
          await new Promise<void>((resolve) => {
            timeoutId = setTimeout(resolve, delay);
          });
          if (cancelled) return;
        }

        const physicsOffset = frameOffset + FRAME_HEADER;
        const graphicsOffset = physicsOffset + physicsSize;
        const staticOffset = graphicsOffset + graphicsSize;

        const physics = data.slice(physicsOffset, physicsOffset + physicsSize);
        const graphics = data.slice(graphicsOffset, graphicsOffset + graphicsSize);
        const staticBuf = data.slice(staticOffset, staticOffset + staticSize);

        const packet = parseAccBuffers(physics, graphics, staticBuf, overrides);
        if (packet) {
          await processPacket(packet);
        }
      }
    } while (loop && !cancelled);

    console.log("[ACC Replay] Playback complete");
  }

  playFrames();

  return {
    stop: () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      console.log("[ACC Replay] Stopped");
    },
    frameCount,
  };
}

export const accRecorder = new AccRecorder();
