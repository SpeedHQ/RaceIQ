/**
 * Kunos shared-memory telemetry recorder.
 *
 * Records raw shared memory frames individually with type information
 * to a binary file for offline development and debugging.
 *
 * Legacy ACCTEST format (v3):
 *   Header: "ACCTEST\0" (8 bytes magic)
 *           u32le version (4 bytes)
 *           u32le frameCount (4 bytes)
 *   Frames: [type(1 byte)] [size(4 bytes)] [data(N bytes)]
 *           type: 0=physics, 1=graphics, 2=static
 *
 * Version history:
 *   v2 — graphics buffer truncated at 1320 bytes (legacy ACC struct view).
 *        isValidLap and other tail fields not captured.
 *   v3 — graphics buffer captured at full 1588 bytes (ACC SDK v1.8.12).
 *        Includes sessionIndex, deltaLapTime, isValidLap, missingMandatoryPits, clock, etc.
 *
 * Reader must accept both versions. Frames are self-describing (length per frame),
 * so V2 bins parse fine — tail fields just return null on V2 buffers.
 */
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { timestampForFilename } from "../../session-capture/filename";
import { WorkerSessionRecorder } from "@raceiq/capture-formats/session/worker-recorder";

// Header: magic(8) + version(4) + frameCount(4) = 16 bytes (same layout v2 and v3)
const HEADER_SIZE = 16;
const RECORDER_VERSION = 3;

function defaultRecordingDir(): string {
  return resolve(process.cwd(), "test", "artifacts", "laps");
}

export class KunosRecorder {
  private _writer: WorkerSessionRecorder | null = null;
  private _path: string | null = null;
  private _frameCount = 0;
  private _lastStatic: Buffer | null = null;
  private _stopping: Promise<void> | null = null;

  get recording(): boolean {
    return this._writer?.recording ?? false;
  }

  get frameCount(): number {
    return this._frameCount;
  }

  get path(): string | null {
    return this._path;
  }

  /** Start recording to a new file. Returns the file path. */
  start(dir?: string, prefix = "acc"): string {
    if (this._writer) {
      void this.stop().catch((error) => {
        console.error("[ACC Recorder] Failed to stop previous recording:", error);
      });
    }

    const outDir = dir ?? defaultRecordingDir();
    const filename = `${prefix}-${timestampForFilename()}-${randomUUID()}.bin`;
    this._path = resolve(outDir, filename);
    this._writer = new WorkerSessionRecorder("acc", {
      headerCountOffset: 12,
      patchCountOnClose: true,
      exclusiveFile: true,
      maxBatchBytes: 4 * 1024 * 1024,
    });
    this._writer.start(this._path);
    this._frameCount = 0;
    this._lastStatic = null;

    const header = Buffer.alloc(HEADER_SIZE);
    Buffer.from("ACCTEST\0", "ascii").copy(header, 0);
    header.writeUInt32LE(RECORDER_VERSION, 8);
    header.writeUInt32LE(0, 12);
    this._writer.writeRawCaptureBytes(header);

    console.log(`[ACC Recorder] Dump file queued: ${filename}`);
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

  /**
   * Record static buffer from shared memory.
   *
   * Deduplicated: only writes a frame when the bytes differ from the last
   * static frame written. The frame reader carries the last-seen static
   * forward when assembling triplets, so every state transition (e.g. the
   * game populating the track name mid-session) is still captured while
   * avoiding ~100Hz duplicate static frames.
   */
  writeStatic(buffer: Buffer): void {
    if (this._lastStatic?.equals(buffer)) return;
    if (this._writeBufferFrame(2, buffer)) this._lastStatic = Buffer.from(buffer);
  }

  /** Stop recording and flush to disk */
  async stop(): Promise<void> {
    if (!this._writer) return this._stopping ?? undefined;

    const writer = this._writer;
    const path = this._path!;
    const frameCount = this._frameCount;
    const fileSize = writer.getCurrentByteOffset();
    this._writer = null;
    this._lastStatic = null;

    const stopping = (async () => {
      await writer.stop();
      const fileSizeKb = (fileSize / 1024).toFixed(2);
      const filename = path.split(/[\\/]/).pop();
      console.log(`[ACC Recorder] Stopped. ${frameCount} frames (${fileSizeKb}KB) written to ${filename}`);
    })();
    this._stopping = stopping;
    try {
      await stopping;
    } finally {
      if (this._stopping === stopping) this._stopping = null;
    }
  }

  private _writeBufferFrame(type: number, buffer: Buffer): boolean {
    const writer = this._writer;
    if (!writer?.recording) {
      console.warn("[ACC Recorder] recorder is inactive, cannot write");
      return false;
    }

    const typeNames = ["physics", "graphics", "static"];
    const record = Buffer.allocUnsafe(5 + buffer.length);
    record.writeUInt8(type, 0);
    record.writeUInt32LE(buffer.length, 1);
    buffer.copy(record, 5);

    if (this._frameCount % 100 === 0) {
      console.log(`[ACC Recorder] Writing frame ${this._frameCount}: type=${typeNames[type]} size=${buffer.length}`);
    }

    writer.writeRawCaptureRecord(record);
    this._frameCount++;
    return true;
  }
}


export const accRecorder = new KunosRecorder();
