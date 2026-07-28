/**
 * iRacing dump-mode recorder.
 *
 * This is intentionally separate from AcRecorder: iRacing emits one
 * self-contained source frame per SDK tick, not an ACC-style shared-memory
 * triplet, and its files must be identifiable without relying on filenames.
 *
 * Format (v1):
 *   Header: "IRIQDMP\0" (8 bytes magic)
 *           u32le version (4 bytes)
 *           u32le frameCount (4 bytes)
 *   Frames: [type(1 byte)] [size(4 bytes)] [data(N bytes)]
 *           type: 0=encoded IRacingSourceFrameV1
 */
import { existsSync, mkdirSync, readFileSync } from "fs";
import { resolve } from "path";
import { gunzipSync } from "zlib";

export const IRACING_DUMP_MAGIC = Buffer.from("IRIQDMP\0", "ascii");
export const IRACING_DUMP_VERSION = 1;

const HEADER_SIZE = 16;
const FRAME_HEADER_SIZE = 5;
const SOURCE_FRAME_TYPE = 0;
const MAX_FRAME_SIZE = 512 * 1024;

function defaultRecordingDir(): string {
  return resolve(process.cwd(), "test", "artifacts", "laps");
}

export class IRacingRecorder {
  private _file: Bun.FileSink | null = null;
  private _path: string | null = null;
  private _frameCount = 0;
  private _stopPromise: Promise<void> | null = null;

  get recording(): boolean {
    return this._file !== null;
  }

  get frameCount(): number {
    return this._frameCount;
  }

  get path(): string | null {
    return this._path;
  }

  start(dir?: string): string {
    if (this._file && this._path) return this._path;
    if (this._stopPromise) {
      throw new Error("Cannot start iRacing recorder while the prior capture is flushing");
    }

    const outDir = dir ?? defaultRecordingDir();
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `iracing-${timestamp}.bin`;
    this._path = resolve(outDir, filename);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._file = (Bun.file(this._path) as any).writer({ append: true });
    this._frameCount = 0;

    const header = Buffer.alloc(HEADER_SIZE);
    IRACING_DUMP_MAGIC.copy(header, 0);
    header.writeUInt32LE(IRACING_DUMP_VERSION, 8);
    header.writeUInt32LE(0, 12);
    this._file!.write(header);

    console.log(`[iRacing Recorder] Dump file created: ${filename}`);
    return this._path;
  }

  writeFrame(frame: Buffer): void {
    if (!this._file) {
      console.warn("[iRacing Recorder] _file is null, cannot write");
      return;
    }
    if (frame.length > MAX_FRAME_SIZE) {
      throw new Error(`iRacing dump frame is too large (${frame.length} bytes)`);
    }

    const header = Buffer.alloc(FRAME_HEADER_SIZE);
    header.writeUInt8(SOURCE_FRAME_TYPE, 0);
    header.writeUInt32LE(frame.length, 1);
    this._file.write(header);
    this._file.write(frame);
    this._frameCount++;
  }

  async stop(): Promise<void> {
    if (this._stopPromise) return this._stopPromise;
    if (!this._file) return;

    const file = this._file;
    const path = this._path;
    const frameCount = this._frameCount;
    this._file = null;
    this._stopPromise = (async () => {
      await file.end();
      if (path) {
        const buf = Buffer.from(await Bun.file(path).arrayBuffer());
        buf.writeUInt32LE(frameCount, 12);
        await Bun.write(path, buf);

        const fileSizeKb = (buf.length / 1024).toFixed(2);
        const filename = path.split(/[\\/]/).pop();
        console.log(
          `[iRacing Recorder] Stopped. ${frameCount} frames (${fileSizeKb}KB) written to ${filename}`,
        );
      }
    })();
    try {
      await this._stopPromise;
    } finally {
      this._stopPromise = null;
    }
  }
}

/**
 * Read raw iRacing source frames from a dump-mode .bin or .bin.gz recording.
 * A zero frame count is treated as an interrupted capture and scanned to the
 * last complete record.
 */
export function readIRacingFrames(filePath: string, limit?: number): Buffer[] {
  const raw = readFileSync(filePath);
  const data = filePath.endsWith(".gz")
    ? Buffer.from(gunzipSync(raw))
    : Buffer.from(raw);

  if (
    data.length < HEADER_SIZE ||
    !data.subarray(0, IRACING_DUMP_MAGIC.length).equals(IRACING_DUMP_MAGIC)
  ) {
    return [];
  }
  if (data.readUInt32LE(8) !== IRACING_DUMP_VERSION) return [];

  const declaredFrameCount = data.readUInt32LE(12);
  const maxFrames = declaredFrameCount === 0
    ? Number.MAX_SAFE_INTEGER
    : declaredFrameCount;
  const frames: Buffer[] = [];
  let offset = HEADER_SIZE;

  while (
    frames.length < maxFrames &&
    offset + FRAME_HEADER_SIZE <= data.length
  ) {
    const frameType = data.readUInt8(offset);
    const frameSize = data.readUInt32LE(offset + 1);
    offset += FRAME_HEADER_SIZE;
    if (
      frameType !== SOURCE_FRAME_TYPE ||
      frameSize === 0 ||
      frameSize > MAX_FRAME_SIZE ||
      offset + frameSize > data.length
    ) {
      break;
    }
    frames.push(Buffer.from(data.subarray(offset, offset + frameSize)));
    offset += frameSize;
    if (limit !== undefined && frames.length >= limit) break;
  }

  return frames;
}

export const iracingRecorder = new IRacingRecorder();
