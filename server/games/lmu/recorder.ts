import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { LMU_MAX_SOURCE_FRAME_SIZE } from "./source-frame";

export const LMU_DUMP_MAGIC = Buffer.from("LMUQDMP\0", "ascii");
export const LMU_DUMP_VERSION = 1;

const HEADER_SIZE = 16;
const FRAME_HEADER_SIZE = 5;
const SOURCE_FRAME_TYPE = 0;

function defaultRecordingDir(): string {
  return resolve(process.cwd(), "test", "artifacts", "laps");
}

export interface LMURecorderContract {
  readonly recording: boolean;
  start(directory?: string): string;
  writeFrame(frame: Buffer): void;
  stop(): Promise<void>;
}

export class LMURecorder implements LMURecorderContract {
  private file: Bun.FileSink | null = null;
  private recordingPath: string | null = null;
  private writtenFrameCount = 0;
  private stopPromise: Promise<void> | null = null;

  get recording(): boolean {
    return this.file !== null;
  }

  get frameCount(): number {
    return this.writtenFrameCount;
  }

  get path(): string | null {
    return this.recordingPath;
  }

  start(directory?: string): string {
    if (this.file && this.recordingPath) return this.recordingPath;
    if (this.stopPromise) {
      throw new Error("Cannot start LMU recorder while prior capture is flushing");
    }

    const outputDirectory = directory ?? defaultRecordingDir();
    if (!existsSync(outputDirectory)) {
      mkdirSync(outputDirectory, { recursive: true });
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.recordingPath = resolve(
      outputDirectory,
      `lmu-${timestamp}.bin`,
    );
    this.file = Bun.file(this.recordingPath).writer();
    this.writtenFrameCount = 0;

    const header = Buffer.alloc(HEADER_SIZE);
    LMU_DUMP_MAGIC.copy(header, 0);
    header.writeUInt32LE(LMU_DUMP_VERSION, 8);
    this.file.write(header);
    return this.recordingPath;
  }

  writeFrame(frame: Buffer): void {
    if (!this.file) return;
    if (frame.length === 0 || frame.length > LMU_MAX_SOURCE_FRAME_SIZE) {
      throw new Error(`LMU dump frame is invalid (${frame.length} bytes)`);
    }
    const header = Buffer.allocUnsafe(FRAME_HEADER_SIZE);
    header.writeUInt8(SOURCE_FRAME_TYPE, 0);
    header.writeUInt32LE(frame.length, 1);
    this.file.write(header);
    this.file.write(frame);
    this.writtenFrameCount++;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.file) return;

    const file = this.file;
    const path = this.recordingPath;
    const frameCount = this.writtenFrameCount;
    this.file = null;
    this.stopPromise = (async () => {
      await file.end();
      if (!path) return;
      const bytes = Buffer.from(await Bun.file(path).arrayBuffer());
      bytes.writeUInt32LE(frameCount, 12);
      await Bun.write(path, bytes);
    })();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }
}

/** Read source frames from LMU dump-mode .bin or .bin.gz captures. */
export function readLMUFrames(filePath: string, limit?: number): Buffer[] {
  const raw = readFileSync(filePath);
  const bytes = filePath.endsWith(".gz")
    ? Buffer.from(gunzipSync(raw))
    : Buffer.from(raw);
  if (
    bytes.length < HEADER_SIZE ||
    !bytes.subarray(0, LMU_DUMP_MAGIC.length).equals(LMU_DUMP_MAGIC) ||
    bytes.readUInt32LE(8) !== LMU_DUMP_VERSION
  ) {
    return [];
  }

  const declaredFrameCount = bytes.readUInt32LE(12);
  const maximumFrames =
    declaredFrameCount === 0 ? Number.MAX_SAFE_INTEGER : declaredFrameCount;
  const frames: Buffer[] = [];
  let offset = HEADER_SIZE;
  while (
    frames.length < maximumFrames &&
    offset + FRAME_HEADER_SIZE <= bytes.length
  ) {
    const frameType = bytes.readUInt8(offset);
    const frameSize = bytes.readUInt32LE(offset + 1);
    offset += FRAME_HEADER_SIZE;
    if (
      frameType !== SOURCE_FRAME_TYPE ||
      frameSize === 0 ||
      frameSize > LMU_MAX_SOURCE_FRAME_SIZE ||
      offset + frameSize > bytes.length
    ) {
      break;
    }
    frames.push(Buffer.from(bytes.subarray(offset, offset + frameSize)));
    offset += frameSize;
    if (limit !== undefined && frames.length >= limit) break;
  }
  return frames;
}

export const lmuRecorder = new LMURecorder();
