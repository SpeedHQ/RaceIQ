import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  LMU_DUMP_FRAME_HEADER_SIZE as FRAME_HEADER_SIZE,
  LMU_DUMP_HEADER_SIZE as HEADER_SIZE,
  LMU_DUMP_MAGIC,
  LMU_DUMP_SOURCE_FRAME_TYPE as SOURCE_FRAME_TYPE,
  LMU_DUMP_VERSION,
} from "@raceiq/capture-formats/lmu/dump";

import { LMU_MAX_SOURCE_FRAME_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { timestampForFilename } from "@raceiq/backend-core/session-capture/filename";

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

export const lmuRecorder = new LMURecorder();
