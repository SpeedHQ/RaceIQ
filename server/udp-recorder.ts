import { existsSync, mkdirSync } from "fs";
import { resolve } from "path";

/**
 * Appends raw UDP packets to a binary dump file.
 *
 * Format: repeated [uint32 LE byte-length][N raw bytes]
 *
 * Append-only writes mean a hard kill truncates at most the last in-flight
 * write — all prior records remain intact. A reader detects truncation by
 * reading the declared length and checking if enough bytes follow.
 */
export class UdpRecorder {
  private _file: Bun.FileSink | null = null;
  private _path: string | null = null;
  private _packetCount = 0;

  get recording(): boolean {
    return this._file !== null;
  }

  get packetCount(): number {
    return this._packetCount;
  }

  get path(): string | null {
    return this._path;
  }

  /** Open dump.bin inside the given session directory. Returns the file path. */
  start(sessionDir: string): string {
    if (this._file) this.stop();
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }
    this._path = resolve(sessionDir, "dump.bin");
    this._file = Bun.file(this._path).writer();
    this._packetCount = 0;
    console.log(`[UdpRecorder] Recording to ${this._path}`);
    return this._path;
  }

  /** Append one raw UDP packet. */
  writePacket(buf: Buffer): void {
    if (!this._file) return;
    const lenBuf = Buffer.allocUnsafe(4);
    lenBuf.writeUInt32LE(buf.length, 0);
    this._file.write(lenBuf);
    this._file.write(buf);
    this._packetCount++;
  }

  /** Flush and close. */
  async stop(): Promise<void> {
    if (!this._file) return;
    await this._file.end();
    console.log(`[UdpRecorder] Stopped. ${this._packetCount} packets written to ${this._path}`);
    this._file = null;
  }
}
