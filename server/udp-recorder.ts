import { existsSync, mkdirSync } from "fs";
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
    console.log(`[UdpRecorder] Recording to ${this._path}`);
    return this._path;
  }

  /**
   * Write a meta frame as frame 0 of the session file.
   * Format: [0xFFFFFFFF uint32 LE][payload_length uint32 LE][payload bytes]
   * Readers detect meta frames by the magic length prefix.
   */
  writeMetaFrame(payload: Buffer): void {
    if (!this._file) return;
    const header = Buffer.allocUnsafe(8);
    header.writeUInt32LE(META_FRAME_MAGIC, 0);
    header.writeUInt32LE(payload.length, 4);
    this._file.write(header);
    this._file.write(payload);
    this._byteOffset += 8 + payload.length;
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

  /** Flush and close. */
  async stop(): Promise<void> {
    if (!this._file) return;
    await this._file.end();
    console.log(`[UdpRecorder] Stopped. ${this._packetCount} packets written to ${this._path}`);
    this._file = null;
  }
}
