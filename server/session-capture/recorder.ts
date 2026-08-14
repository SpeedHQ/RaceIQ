import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import type { ArchiveVerification } from "../../shared/racing/quality/contracts";
import { dirname } from "node:path";
import { encodeFrameLength, encodeMetaFrame, iterateSessionFrameRecords, META_FRAME_BYTES, META_FRAME_MAGIC } from "./framing";

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
  private _hasher = createHash("sha256");

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
    this._hasher = createHash("sha256");
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
    const prefix = encodeFrameLength(buf.length);
    this._file.write(prefix);
    this._file.write(buf);
    this._hasher.update(prefix);
    this._hasher.update(buf);
    this._recordCount++;
    this._byteOffset += prefix.length + buf.length;
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

  /** Flush, patch total frame count, close, and verify framing plus digest. */
  async stop(): Promise<ArchiveVerification> {
    const path = this._path;
    const file = this._file;
    const count = this._recordCount;
    const expectedBytes = this._byteOffset;
    const hadMeta = this._metaPending;
    this._file = null;
    this._metaPending = false;
    this._active = false;
    if (!file || !path) {
      return { state: "unavailable", sourceGeneration: null, details: "No records were written" };
    }

    let closeFailure: unknown;
    try {
      await file.end();
    } catch (error) {
      closeFailure = error;
    }
    const sourceGeneration = `sha256:${this._hasher.digest("hex")}`;
    if (closeFailure) {
      return {
        state: "corrupt",
        sourceGeneration,
        details: closeFailure instanceof Error ? closeFailure.message : String(closeFailure),
      };
    }

    if (hadMeta) {
      try {
        const countBuf = encodeFrameLength(count);
        const fd = openSync(path, "r+");
        try {
          writeSync(fd, countBuf, 0, countBuf.length, 8);
        } finally {
          closeSync(fd);
        }
      } catch (error) {
        return {
          state: "corrupt",
          sourceGeneration,
          details: error instanceof Error ? error.message : String(error),
        };
      }
    }

    let verification: ArchiveVerification;
    try {
      if (!existsSync(path)) {
        verification = { state: "unavailable", sourceGeneration: null, details: "Recording file disappeared before verification" };
      } else {
        const bytes = readFileSync(path);
        if (bytes.length < expectedBytes) {
          verification = { state: "truncated", sourceGeneration, details: `Expected ${expectedBytes} bytes, found ${bytes.length}` };
        } else if (bytes.length > expectedBytes) {
          verification = { state: "corrupt", sourceGeneration, details: `Expected ${expectedBytes} bytes, found ${bytes.length}` };
        } else if (
          hadMeta &&
          (bytes.length < META_FRAME_BYTES ||
            bytes.readUInt32LE(0) !== META_FRAME_MAGIC ||
            bytes.readUInt32LE(4) !== META_FRAME_BYTES - 8 ||
            bytes.readUInt32LE(8) !== count)
        ) {
          verification = { state: "corrupt", sourceGeneration, details: "Recording metadata frame does not match written frame count" };
        } else {
          const actualHash = createHash("sha256");
          let actualCount = 0;
          for (const record of iterateSessionFrameRecords(bytes, hadMeta ? META_FRAME_BYTES : 0, { strict: true })) {
            actualHash.update(bytes.subarray(record.offset, record.offset + 4 + record.frame.length));
            actualCount++;
          }
          if (actualCount !== count) {
            verification = { state: "corrupt", sourceGeneration, details: `Expected ${count} frames, found ${actualCount}` };
          } else if (`sha256:${actualHash.digest("hex")}` !== sourceGeneration) {
            verification = { state: "corrupt", sourceGeneration, details: "Recording digest does not match written frames" };
          } else {
            verification = { state: "verified", sourceGeneration };
          }
        }
      }
    } catch (error) {
      const details = error instanceof Error ? error.message : String(error);
      verification = {
        state: /truncated/i.test(details) ? "truncated" : "corrupt",
        sourceGeneration,
        details,
      };
    }
    console.log(`[SessionRecorder] Stopped. ${count} records written to ${path}`);
    return verification;
  }
}
