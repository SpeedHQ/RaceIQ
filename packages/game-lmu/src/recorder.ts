import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  LMU_DUMP_FRAME_HEADER_SIZE as FRAME_HEADER_SIZE,
  LMU_DUMP_HEADER_SIZE as HEADER_SIZE,
  LMU_DUMP_MAGIC,
  LMU_DUMP_SOURCE_FRAME_TYPE as SOURCE_FRAME_TYPE,
  LMU_DUMP_VERSION,
} from "@raceiq/capture-formats/lmu/dump-decoder";

import { LMU_MAX_SOURCE_FRAME_SIZE } from "@raceiq/capture-formats/lmu/source-frame";
import { WorkerSessionRecorder } from "@raceiq/capture-formats/session/worker-recorder";

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
  private writer: WorkerSessionRecorder | null = null;
  private recordingPath: string | null = null;
  private writtenFrameCount = 0;
  private stopPromise: Promise<void> | null = null;

  get recording(): boolean {
    return this.writer?.recording ?? false;
  }

  get frameCount(): number {
    return this.writtenFrameCount;
  }

  get path(): string | null {
    return this.recordingPath;
  }

  start(directory?: string): string {
    if (this.writer?.recording && this.recordingPath) return this.recordingPath;
    if (this.stopPromise) throw new Error("Cannot start LMU recorder while prior capture is flushing");

    const outputDirectory = directory ?? defaultRecordingDir();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    this.recordingPath = resolve(outputDirectory, `lmu-${timestamp}-${randomUUID()}.bin`);
    this.writer = new WorkerSessionRecorder("lmu", {
      headerCountOffset: 12,
      patchCountOnClose: true,
      exclusiveFile: true,
      maxBatchBytes: 4 * 1024 * 1024,
    });
    this.writer.start(this.recordingPath);
    this.writtenFrameCount = 0;

    const header = Buffer.alloc(HEADER_SIZE);
    LMU_DUMP_MAGIC.copy(header, 0);
    header.writeUInt32LE(LMU_DUMP_VERSION, 8);
    this.writer.writeRawCaptureBytes(header);
    return this.recordingPath;
  }

  writeFrame(frame: Buffer): void {
    if (!this.writer?.recording) return;
    if (frame.length === 0 || frame.length > LMU_MAX_SOURCE_FRAME_SIZE) {
      throw new Error(`LMU dump frame is invalid (${frame.length} bytes)`);
    }
    const record = Buffer.allocUnsafe(FRAME_HEADER_SIZE + frame.length);
    record.writeUInt8(SOURCE_FRAME_TYPE, 0);
    record.writeUInt32LE(frame.length, 1);
    frame.copy(record, FRAME_HEADER_SIZE);
    this.writer.writeRawCaptureRecord(record);
    this.writtenFrameCount++;
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    if (!this.writer) return;

    const writer = this.writer;
    this.writer = null;
    this.stopPromise = (async () => {
      await writer.stop();
    })();
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = null;
    }
  }
}

export const lmuRecorder = new LMURecorder();
