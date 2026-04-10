/**
 * Test ACC memory reader that replays from a recorded dump file.
 *
 * Dump format:
 *   Header: "ACCTEST\0" (8 bytes magic)
 *           u32le version (4 bytes, currently 1)
 *           u32le frameCount (4 bytes)
 *   Frames: Each frame is [type(1)] [timestamp(8)] [size(4)] [data(N)]
 *           type: 0=physics, 1=graphics, 2=static
 */

import { readFileSync } from "fs";
import { ITestAccMemoryReader } from "./memory-reader";

const MAGIC = Buffer.from("ACCTEST\0", "ascii");
const VERSION = 1;
const HEADER_SIZE = 8 + 4 + 4; // magic + version + frameCount

type FrameType = "physics" | "graphics" | "static";

interface RecordedFrame {
  type: FrameType;
  timestamp: number;
  data: Buffer;
}

export class TestAccMemoryReader implements ITestAccMemoryReader {
  private _frames: RecordedFrame[] = [];
  private _frameIndex = 0;
  private _connected = false;
  private _running = false;
  private _lastPhysics: Buffer | null = null;
  private _lastGraphics: Buffer | null = null;
  private _lastStatic: Buffer | null = null;

  constructor(private _filePath: string) {}

  connected(): boolean {
    return this._connected;
  }

  running(): boolean {
    return this._running;
  }

  frameCount(): number {
    return this._frames.length;
  }

  currentFrame(): number {
    return this._frameIndex;
  }

  seekTo(frameNumber: number): void {
    this._frameIndex = Math.max(0, Math.min(frameNumber, this._frames.length - 1));
    this._lastPhysics = null;
    this._lastGraphics = null;
    this._lastStatic = null;
  }

  start(): void {
    if (this._running) return;

    try {
      const data = readFileSync(this._filePath);
      this._loadDump(data);
      this._running = true;
      this._connected = this._frames.length > 0;

      if (this._connected) {
        console.log(`[ACC Test Reader] Loaded ${this._frames.length} frames from ${this._filePath}`);
      } else {
        console.error(`[ACC Test Reader] Failed to load frames from ${this._filePath}`);
      }
    } catch (e) {
      console.error(`[ACC Test Reader] Failed to read dump: ${e}`);
      this._running = true;
      this._connected = false;
    }
  }

  async stop(): Promise<void> {
    this._running = false;
    this._connected = false;
    this._frames = [];
    this._frameIndex = 0;
  }

  nextFrame(): { physics?: Buffer; graphics?: Buffer; staticData?: Buffer } | null {
    if (!this._connected || this._frameIndex >= this._frames.length) {
      return null;
    }

    const frame = this._frames[this._frameIndex];
    this._frameIndex++;

    const result: { physics?: Buffer; graphics?: Buffer; staticData?: Buffer } = {};

    switch (frame.type) {
      case "physics":
        this._lastPhysics = frame.data;
        result.physics = frame.data;
        break;
      case "graphics":
        this._lastGraphics = frame.data;
        result.graphics = frame.data;
        break;
      case "static":
        this._lastStatic = frame.data;
        result.staticData = frame.data;
        break;
    }

    // Always include the latest of each buffer type so parseAccBuffers gets all three
    if (this._lastPhysics) result.physics = this._lastPhysics;
    if (this._lastGraphics) result.graphics = this._lastGraphics;
    if (this._lastStatic) result.staticData = this._lastStatic;

    return Object.keys(result).length > 0 ? result : null;
  }

  private _loadDump(data: Buffer): void {
    if (data.length < HEADER_SIZE) {
      console.error("[ACC Test Reader] Dump file too small");
      return;
    }

    // Check magic
    if (!data.slice(0, 8).equals(MAGIC)) {
      console.error("[ACC Test Reader] Invalid dump file magic");
      return;
    }

    const version = data.readUInt32LE(8);
    if (version !== VERSION) {
      console.error(`[ACC Test Reader] Unsupported version: ${version}`);
      return;
    }

    const frameCount = data.readUInt32LE(12);
    let offset = HEADER_SIZE;

    for (let i = 0; i < frameCount && offset < data.length; i++) {
      if (offset + 13 > data.length) break; // Not enough for header

      const frameType = data.readUInt8(offset);
      const timestamp = data.readDoubleLE(offset + 1);
      const bufferSize = data.readUInt32LE(offset + 9);

      offset += 13;

      if (offset + bufferSize > data.length) break; // Truncated

      const bufferData = Buffer.from(data.subarray(offset, offset + bufferSize));
      offset += bufferSize;

      let type: FrameType;
      switch (frameType) {
        case 0:
          type = "physics";
          break;
        case 1:
          type = "graphics";
          break;
        case 2:
          type = "static";
          break;
        default:
          continue;
      }

      this._frames.push({ type, timestamp, data: bufferData });
    }
  }
}
