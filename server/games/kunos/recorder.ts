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
import { existsSync, mkdirSync } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";

// Header: magic(8) + version(4) + frameCount(4) = 16 bytes (same layout v2 and v3)
const HEADER_SIZE = 16;
const RECORDER_VERSION = 3;

function defaultRecordingDir(): string {
  return resolve(process.cwd(), "test", "artifacts", "laps");
}

export class KunosRecorder {
  private _file: Bun.FileSink | null = null;
  private _path: string | null = null;
  private _frameCount = 0;
  private _lastStatic: Buffer | null = null;

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
  start(dir?: string, prefix = "acc"): string {
    if (this._file) {
      throw new Error("ACC recorder is already recording");
    }

    const outDir = dir ?? defaultRecordingDir();
    if (!existsSync(outDir)) {
      mkdirSync(outDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${prefix}-${timestamp}.bin`;
    this._path = resolve(outDir, filename);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this._file = (Bun.file(this._path) as any).writer({ append: true });
    this._frameCount = 0;
    this._lastStatic = null;

    // Write header with placeholder frameCount (will update on close)
    const header = Buffer.alloc(HEADER_SIZE);
    Buffer.from("ACCTEST\0", "ascii").copy(header, 0);
    header.writeUInt32LE(RECORDER_VERSION, 8);
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
    this._lastStatic = Buffer.from(buffer);
    this._writeBufferFrame(2, buffer);
  }

  /** Stop recording and flush to disk */
  async stop(): Promise<void> {
    const sink = this._file;
    const path = this._path;
    const frameCount = this._frameCount;
    if (!sink || !path) return;

    // Detach before awaiting I/O so a restarted telemetry source can safely
    // begin a new recording while this file finishes flushing.
    this._file = null;
    this._lastStatic = null;

    await sink.end();

    // Patch only the frame-count field. Reading and rewriting the full capture
    // made long-session shutdown slow and allowed source restarts to race with
    // finalization through the recorder's mutable path/file state.
    const frameCountBuffer = Buffer.allocUnsafe(4);
    frameCountBuffer.writeUInt32LE(frameCount, 0);
    const file = await open(path, "r+");
    let fileSize: number;
    try {
      await file.write(frameCountBuffer, 0, frameCountBuffer.length, 12);
      fileSize = (await file.stat()).size;
    } finally {
      await file.close();
    }

    const fileSizeKb = (fileSize / 1024).toFixed(2);
    const filename = path.split(/[\\/]/).pop();
    console.log(`[ACC Recorder] Stopped. ${frameCount} frames (${fileSizeKb}KB) written to ${filename}`);
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


export const accRecorder = new KunosRecorder();
