/**
 * iRacing dump-mode recorder.
 *
 * This is intentionally separate from KunosRecorder: iRacing emits one
 * packed source frame per SDK tick, not an ACC-style shared-memory triplet,
 * and its files must be identifiable without relying on filenames.
 *
 * Format (v2):
 *   Header: "IRIQDMP\0" (8 bytes magic)
 *           u32le version (4 bytes)
 *           u32le frameCount (4 bytes)
 *   Frames: [type(1 byte)] [size(4 bytes)] [data(N bytes)]
 *           type: 0=packed iRacing session/value-delta source frame
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  IRACING_DUMP_FRAME_HEADER_SIZE as FRAME_HEADER_SIZE,
  IRACING_DUMP_HEADER_SIZE as HEADER_SIZE,
  IRACING_DUMP_MAGIC,
  IRACING_DUMP_SOURCE_FRAME_TYPE as SOURCE_FRAME_TYPE,
  IRACING_DUMP_VERSION,
} from "@raceiq/capture-formats/iracing/dump-decoder";
import { IRACING_MAX_SOURCE_FRAME_SIZE } from "@raceiq/capture-formats/iracing/source-frame";
import { WorkerSessionRecorder } from "@raceiq/capture-formats/session/worker-recorder";
import { timestampForFilename } from "@raceiq/backend-core/session-capture/filename";


function defaultRecordingDir(): string {
  return resolve(process.cwd(), "test", "artifacts", "laps");
}


export class IRacingRecorder {
  private _writer: WorkerSessionRecorder | null = null;
  private _path: string | null = null;
  private _frameCount = 0;
  private _stopPromise: Promise<void> | null = null;

  get recording(): boolean {
    return this._writer?.recording ?? false;
  }

  get frameCount(): number {
    return this._frameCount;
  }

  get path(): string | null {
    return this._path;
  }

  start(dir?: string): string {
    if (this._writer?.recording && this._path) return this._path;
    if (this._stopPromise) throw new Error("Cannot start iRacing recorder while the prior capture is flushing");

    const outDir = dir ?? defaultRecordingDir();
    const filename = `iracing-${timestampForFilename()}-${randomUUID()}.bin`;
    this._path = resolve(outDir, filename);
    this._writer = new WorkerSessionRecorder("iracing", {
      headerCountOffset: 12,
      patchCountOnClose: true,
      exclusiveFile: true,
      maxBatchBytes: 4 * 1024 * 1024,
    });
    this._writer.start(this._path);
    this._frameCount = 0;

    const header = Buffer.alloc(HEADER_SIZE);
    IRACING_DUMP_MAGIC.copy(header, 0);
    header.writeUInt32LE(IRACING_DUMP_VERSION, 8);
    header.writeUInt32LE(0, 12);
    this._writer.writeRawCaptureBytes(header);

    console.log(`[iRacing Recorder] Dump file queued: ${filename}`);
    return this._path;
  }

  writeFrame(frame: Buffer): void {
    if (!this._writer?.recording) {
      console.warn("[iRacing Recorder] recorder is inactive, cannot write");
      return;
    }
    if (frame.length > IRACING_MAX_SOURCE_FRAME_SIZE) throw new Error(`iRacing dump frame is too large (${frame.length} bytes)`);

    const record = Buffer.allocUnsafe(FRAME_HEADER_SIZE + frame.length);
    record.writeUInt8(SOURCE_FRAME_TYPE, 0);
    record.writeUInt32LE(frame.length, 1);
    frame.copy(record, FRAME_HEADER_SIZE);
    this._writer.writeRawCaptureRecord(record);
    this._frameCount++;
  }

  async stop(): Promise<void> {
    if (this._stopPromise) return this._stopPromise;
    if (!this._writer) return;

    const writer = this._writer;
    const path = this._path;
    const frameCount = this._frameCount;
    const fileSize = writer.getCurrentByteOffset();
    this._writer = null;
    this._stopPromise = (async () => {
      await writer.stop();
      if (path) {
        const fileSizeKb = (fileSize / 1024).toFixed(2);
        const filename = path.split(/[\\/]/).pop();
        console.log(`[iRacing Recorder] Stopped. ${frameCount} frames (${fileSizeKb}KB) written to ${filename}`);
      }
    })();
    try {
      await this._stopPromise;
    } finally {
      this._stopPromise = null;
    }
  }
}

export const iracingRecorder = new IRacingRecorder();
