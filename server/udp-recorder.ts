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
 */
/** Magic length value that marks a meta frame (not a real UDP packet). */
export const META_FRAME_MAGIC = 0xffffffff;

export class UdpRecorder {
  private _file: Bun.FileSink | null = null;
  private _path: string | null = null;
  private _packetCount = 0;
  private _byteOffset = 0;
  private _hasMetaFrame = false;

  get recording(): boolean {
    return this._file !== null;
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

  /** Open the given file path. Creates parent directories as needed. Returns the file path. */
  start(filePath: string): string {
    if (this._file) this.stop();
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    this._path = filePath;
    this._file = Bun.file(this._path).writer();
    this._packetCount = 0;
    this._byteOffset = 0;
    this._hasMetaFrame = false;
    console.log(`[UdpRecorder] Recording to ${this._path}`);
    return this._path;
  }

  /**
   * Write the session header as frame 0.
   * Format: [0xFFFFFFFF uint32 LE][4 uint32 LE][totalFrames uint32 LE]
   * totalFrames is written as 0 initially and patched to the real count on stop().
   */
  writeMetaFrame(_unused?: Buffer): void {
    if (!this._file) return;
    const header = Buffer.allocUnsafe(12);
    header.writeUInt32LE(META_FRAME_MAGIC, 0);
    header.writeUInt32LE(4, 4); // payload length = 4 bytes
    header.writeUInt32LE(0, 8); // total frame count placeholder — patched on stop()
    this._file.write(header);
    this._byteOffset += 12;
    this._hasMetaFrame = true;
  }

  /** Append one raw UDP packet. */
  writePacket(buf: Buffer): void {
    if (!this._file) return;
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32LE(buf.length, 0);
    this._file.write(lenBuf);
    this._file.write(buf);
    this._packetCount++;
    this._byteOffset += 4 + buf.length;
  }

  /** Flush, patch total frame count into header, and close. */
  async stop(): Promise<void> {
    if (!this._file || !this._path) return;
    const path = this._path;
    const count = this._packetCount;
    const hasMetaFrame = this._hasMetaFrame;
    await this._file.end();
    this._file = null;
    // Patch bytes 8–11 with the final packet count (only if meta frame was written)
    if (hasMetaFrame) {
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
