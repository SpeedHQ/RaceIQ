import { existsSync, mkdirSync, openSync, writeSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { encodeFrameLength, encodeMetaFrame, encodeSegmentBoundaryFrame, META_FRAME_BYTES } from "./framing";

/**
 * Appends raw telemetry records to a binary dump file.
 *
 * Format: repeated [uint32 LE byte-length][N raw bytes]
 *
 * Append-only writes mean a hard kill truncates at most the last in-flight
 * write — all prior records remain intact. A reader detects truncation by
 * reading the declared length and checking if enough bytes follow.
 *
 * File creation is deferred until the first telemetry record arrives. A session
 * that only calls start() + writeMetaFrame() and ends without any records
 * (e.g. sim in menu, car/track flap, app shutdown) leaves no .bin on disk.
 */

export class SessionRecorder {
  private _file: Bun.FileSink | null = null;
  private _path: string | null = null;
  private _recordCount = 0;
  private _byteOffset = 0;
  private _metaPending = false;
  private _active = false;

  get recording(): boolean {
    return this._active;
  }

  get recordCount(): number {
    return this._recordCount;
  }

  get path(): string | null {
    return this._path;
  }

  /** Current byte offset in the file — snapshot this at lap start for O(1) seek on re-parse. */
  getCurrentByteOffset(): number {
    return this._byteOffset;
  }

  /**
   * Reserve a file path for this session. No file is created on disk until
   * the first writeRecord() call — empty sessions leave nothing behind.
   */
  start(filePath: string): string {
    if (this._active) this.stop();
    this._path = filePath;
    this._recordCount = 0;
    this._byteOffset = 0;
    this._metaPending = false;
    this._active = true;
    return this._path;
  }

  /**
   * Reserve the 12-byte meta frame at offset 0. Actual bytes are written to
   * disk on the first writeRecord() call (lazy-open), so the lap byte-offset
   * pipeline sees (12) matches what will be on disk once records arrive.
   *
   * Format: [0xFFFFFFFF uint32 LE][4 uint32 LE][totalFrames uint32 LE]
   * totalFrames is written as 0 initially and patched to the real count on stop().
   */
  writeMetaFrame(): void {
    if (!this._active || this._metaPending || this._file) return;
    this._metaPending = true;
    this._byteOffset += META_FRAME_BYTES;
  }

  /** Append one telemetry record. Opens the file + writes meta header on first call. */
  writeRecord(buf: Buffer): void {
    if (!this._active) return;
    if (!this._file) this._openAndWriteMeta();
    if (!this._file) return;
    this._file.write(encodeFrameLength(buf.length));
    this._file.write(buf);
    this._recordCount++;
    this._byteOffset += 4 + buf.length;
  }

  /** Append a tagged segment boundary without affecting telemetry count. */
  writeSegmentBoundary(): void {
    if (!this._active || !this._file) return;
    this._file.write(encodeSegmentBoundaryFrame());
    this._byteOffset += 16;
  }

  private _openAndWriteMeta(): void {
    if (!this._path || this._file) return;
    const dir = dirname(this._path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this._file = Bun.file(this._path).writer();
    console.log(`[SessionRecorder] Recording to ${this._path}`);
    if (this._metaPending) {
      this._file.write(encodeMetaFrame());
    }
  }

  /**
   * Flush buffered writes to disk without closing. Call periodically (e.g. 1Hz
   * from the status timer) and before saving a lap so the DB offset / frame
   * count are in sync with what's actually on disk. Otherwise a crash or hard
   * exit strands buffered data and lap records point past the EOF.
   */
  flush(): void {
    if (!this._file) return;
    try {
      this._file.flush();
    } catch {
      // Non-fatal — periodic flush is best-effort
    }
  }

  /** Flush, patch total frame count into header, and close. No file is created if no records were written. */
  async stop(): Promise<void> {
    const path = this._path;
    const file = this._file;
    const count = this._recordCount;
    const hadMeta = this._metaPending;
    this._file = null;
    this._metaPending = false;
    this._active = false;
    if (!file || !path) return;
    await file.end();
    if (hadMeta) {
      try {
        const countBuf = encodeFrameLength(count);
        const fd = openSync(path, "r+");
        try {
          writeSync(fd, countBuf, 0, countBuf.length, 8);
        } finally {
          closeSync(fd);
        }
      } catch {
        // Non-fatal: header patch failing doesn't corrupt the record data
      }
    }
    console.log(`[SessionRecorder] Stopped. ${count} records written to ${path}`);
  }
}
