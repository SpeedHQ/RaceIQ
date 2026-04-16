/**
 * ACC telemetry recorder and replayer.
 *
 * Records raw shared memory frames individually with type information
 * to a binary file for offline development and debugging.
 *
 * New format (v2):
 *   Header: "ACCTEST\0" (8 bytes magic) — NOTE: changed from ACCREC for new format
 *           u32le version (4 bytes, currently 2)
 *           u32le frameCount (4 bytes)
 *   Frames: [type(1 byte)] [timestamp(8 bytes f64)] [size(4 bytes)] [data(N bytes)]
 *           type: 0=physics, 1=graphics, 2=static
 *
 * Replay reads frames individually, preserving the realistic async timing
 * between physics (~300Hz), graphics (~60Hz), and static (once) updates.
 */
import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";
export { readAccFrames } from "./frame-reader";
import { STATIC } from "./structs";
import { parseAccBuffers } from "./parser";
import { readWString } from "./utils";
import { processPacket } from "../../pipeline";
import { getAccCarByModel } from "../../../shared/acc-car-data";
import { getAccTrackByName } from "../../../shared/acc-track-data";

const MAGIC = Buffer.from("ACCREC\0\0", "ascii");
const VERSION = 1;
// V1 format: magic(8) + version(4) + physicsSize(4) + graphicsSize(4) + staticSize(4) = 24 bytes
const HEADER_SIZE_V1 = 8 + 4 + 4 + 4 + 4;
// V2 format: magic(8) + version(4) + frameCount(4) = 16 bytes
const HEADER_SIZE_V2 = 16;
const FRAME_HEADER = 8; // f64le timestamp

function defaultRecordingDir(): string {
  return resolve(process.cwd(), "test", "artifacts", "laps");
}

export class AccRecorder {
  private _file: Bun.FileSink | null = null;
  private _path: string | null = null;
  private _frameCount = 0;

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
    const filename = `acc-${timestamp}.bin`;
    this._path = resolve(outDir, filename);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._file = (Bun.file(this._path) as any).writer({ append: true });
    this._frameCount = 0;

    // Write header with placeholder frameCount (will update on close)
    const header = Buffer.alloc(HEADER_SIZE_V2);
    Buffer.from("ACCTEST\0", "ascii").copy(header, 0);
    header.writeUInt32LE(2, 8); // version 2
    header.writeUInt32LE(0, 12); // frameCount (placeholder)
    this._file!.write(header);

    console.log(`[ACC Recorder] Dump file created: ${filename}`);
    return this._path;
  }

  /** Record physics buffer from shared memory */
  writePhysics(buffer: Buffer): void {
    this._writeBufferFrame(0, buffer);
  }

  /** Record graphics buffer from shared memory */
  writeGraphics(buffer: Buffer): void {
    this._writeBufferFrame(1, buffer);
  }

  /** Record static buffer from shared memory (typically once per session) */
  writeStatic(buffer: Buffer): void {
    this._writeBufferFrame(2, buffer);
  }

  /** Deprecated: old API that wrote triplets. Use writePhysics/writeGraphics/writeStatic instead. */
  writeFrame(physics: Buffer, graphics: Buffer, staticData: Buffer): void {
    if (!this._file) return;
    this.writePhysics(physics);
    this.writeGraphics(graphics);
    this.writeStatic(staticData);
  }

  /** Stop recording and flush to disk */
  async stop(): Promise<void> {
    if (!this._file) return;

    await this._file.end();

    // Update frameCount in header and get final file size
    if (this._path) {
      const file = Bun.file(this._path);
      const data = await file.arrayBuffer();
      const buf = Buffer.from(data);
      buf.writeUInt32LE(this._frameCount, 12);
      await Bun.write(this._path, buf);

      const fileSizeKb = (buf.length / 1024).toFixed(2);
      const filename = this._path.split(/[\\\/]/).pop();
      console.log(`[ACC Recorder] Stopped. ${this._frameCount} frames (${fileSizeKb}KB) written to ${filename}`);
    }

    this._file = null;
  }

  private _writeBufferFrame(type: number, buffer: Buffer): void {
    if (!this._file) {
      console.warn("[ACC Recorder] _file is null, cannot write");
      return;
    }

    const typeNames = ["physics", "graphics", "static"];
    const frameHeader = Buffer.alloc(5);
    frameHeader.writeUInt8(type, 0);
    frameHeader.writeUInt32LE(buffer.length, 1);

    if (this._frameCount % 100 === 0) {
      console.log(
        `[ACC Recorder] Writing frame ${this._frameCount}: type=${typeNames[type]} size=${buffer.length}`
      );
    }

    this._file.write(frameHeader);
    this._file.write(buffer);
    this._frameCount++;
  }
}

/** Parse and validate a recording file header. Returns sizes or null if invalid. */
function readHeader(buf: Buffer): {
  physicsSize: number;
  graphicsSize: number;
  staticSize: number;
} | null {
  if (buf.length < HEADER_SIZE_V1) return null;
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
  const frameCount = Math.floor((data.length - HEADER_SIZE_V1) / frameSize);

  if (frameCount === 0) {
    throw new Error(`Recording file has no frames: ${filePath}`);
  }

  // Resolve car/track ordinals from first frame's static buffer
  const firstStaticOffset = HEADER_SIZE_V1 + FRAME_HEADER + physicsSize + graphicsSize;
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

        const frameOffset = HEADER_SIZE_V1 + i * frameSize;
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
