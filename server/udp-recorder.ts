import { existsSync, mkdirSync, openSync, writeSync, closeSync } from "fs";
import { dirname } from "path";

/**
 * Appends raw UDP packets to a binary dump file.
 *
 * Format: repeated [uint32 LE byte-length][N raw bytes]
 *
 * Append-only writes mean a hard kill truncates at most the last in-flight
 * write — all prior records remain intact. A reader detects truncation by
 * reading the declared length and checking if enough bytes follow.
 *
 * File creation is deferred until the first real packet arrives. A session
 * that only calls start() + writeMetaFrame() and ends without any packets
 * (e.g. sim in menu, car/track flap, app shutdown) leaves no .bin on disk.
 */
/** Magic length value that marks a meta frame (not a real UDP packet). */
export const META_FRAME_MAGIC = 0xffffffff;

export class UdpRecorder {
  private _file: Bun.FileSink | null = null;
  private _path: string | null = null;
  private _packetCount = 0;
  private _byteOffset = 0;
  private _metaPending = false;
  private _active = false;

  get recording(): boolean {
    return this._active;
  }

  get packetCount(): number {
    return this._packetCount;
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
   * the first writePacket() call — empty sessions leave nothing behind.
   */
  start(filePath: string): string {
    if (this._active) this.stop();
    this._path = filePath;
    this._packetCount = 0;
    this._byteOffset = 0;
    this._metaPending = false;
    this._active = true;
    return this._path;
  }

  /**
   * Reserve the 12-byte meta frame at offset 0. Actual bytes are written to
   * disk on the first writePacket() call (lazy-open), so the lap byte-offset
   * pipeline sees (12) matches what will be on disk once packets arrive.
   *
   * Format: [0xFFFFFFFF uint32 LE][4 uint32 LE][totalFrames uint32 LE]
   * totalFrames is written as 0 initially and patched to the real count on stop().
   */
  writeMetaFrame(_unused?: Buffer): void {
    if (!this._active || this._metaPending || this._file) return;
    this._metaPending = true;
    this._byteOffset += 12;
  }

  /** Append one raw UDP packet. Opens the file + writes meta header on first call. */
  writePacket(buf: Buffer): void {
    if (!this._active) return;
    if (!this._file) this._openAndWriteMeta();
    if (!this._file) return;
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32LE(buf.length, 0);
    this._file.write(lenBuf);
    this._file.write(buf);
    this._packetCount++;
    this._byteOffset += 4 + buf.length;
  }

  private _openAndWriteMeta(): void {
    if (!this._path || this._file) return;
    const dir = dirname(this._path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this._file = Bun.file(this._path).writer();
    console.log(`[UdpRecorder] Recording to ${this._path}`);
    if (this._metaPending) {
      const header = Buffer.allocUnsafe(12);
      header.writeUInt32LE(META_FRAME_MAGIC, 0);
      header.writeUInt32LE(4, 4);
      header.writeUInt32LE(0, 8);
      this._file.write(header);
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

  /** Flush, patch total frame count into header, and close. No file is created if no packets were written. */
  async stop(): Promise<void> {
    const path = this._path;
    const file = this._file;
    const count = this._packetCount;
    const hadMeta = this._metaPending;
    this._file = null;
    this._metaPending = false;
    this._active = false;
    if (!file || !path) return;
    await file.end();
    if (hadMeta) {
      try {
        const countBuf = Buffer.allocUnsafe(4);
        countBuf.writeUInt32LE(count, 0);
        const fd = openSync(path, "r+");
        writeSync(fd, countBuf, 0, 4, 8);
        closeSync(fd);
      } catch {
        // Non-fatal: header patch failing doesn't corrupt the packet data
      }
    }
    console.log(`[UdpRecorder] Stopped. ${count} packets written to ${path}`);
  }
}
