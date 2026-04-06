/**
 * ACC Shared Memory Reader using Bun FFI.
 *
 * Reads ACC's three memory-mapped files:
 * - acpmf_physics (~300Hz physics data)
 * - acpmf_graphics (~60Hz session/race data)
 * - acpmf_static (once per session)
 *
 * Uses kernel32.dll via Bun FFI to open and map shared memory.
 *
 * FFI is loaded lazily at start() time so this module can be imported
 * safely on any platform and before the parser module exists.
 */
import { PHYSICS, GRAPHICS, STATIC, AC_STATUS } from "./structs";
import { processPacket } from "../../pipeline";
import { accRecorder } from "./recorder";
import { readWString } from "./utils";
import { isGameRunning } from "../registry";

// Re-export utilities so tests can import readWString from this module
export { readWString, toWideString } from "./utils";

const FILE_MAP_READ = 0x0004;

interface Kernel32 {
  symbols: {
    OpenFileMappingW(access: number, inherit: boolean, name: unknown): unknown;
    MapViewOfFile(handle: unknown, access: number, offHigh: number, offLow: number, size: number): unknown;
    UnmapViewOfFile(view: unknown): boolean;
    CloseHandle(handle: unknown): boolean;
    RtlCopyMemory(dest: unknown, src: unknown, length: number): void;
  };
}

interface MappedFile {
  handle: number;
  view: number;
  size: number;
}

function openSharedMemory(
  kernel32: Kernel32,
  ptr: (buf: Buffer) => unknown,
  name: string,
  readSize: number
): MappedFile | null {
  const { toWideString } = require("./utils") as typeof import("./utils");
  const wideName = toWideString(name);
  const handle = kernel32.symbols.OpenFileMappingW(FILE_MAP_READ, false, ptr(wideName));

  if (!handle || handle === 0) {
    return null;
  }

  // Pass 0 as size to map the entire shared memory region.
  // This avoids segfaults from mismatched struct size assumptions —
  // ACC's actual struct sizes vary between versions.
  const view = kernel32.symbols.MapViewOfFile(handle, FILE_MAP_READ, 0, 0, 0);
  if (!view || view === 0) {
    kernel32.symbols.CloseHandle(handle);
    return null;
  }

  // readSize is how many bytes we'll read from the mapped region
  return { handle: Number(handle), view: Number(view), size: readSize };
}

function closeSharedMemory(kernel32: Kernel32, mapped: MappedFile): void {
  kernel32.symbols.UnmapViewOfFile(mapped.view);
  kernel32.symbols.CloseHandle(mapped.handle);
}

export class AccSharedMemoryReader {
  private _physics: MappedFile | null = null;
  private _graphics: MappedFile | null = null;
  private _static: MappedFile | null = null;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _retryTimer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _connected = false;
  private _carOrdinal = 0;
  private _trackOrdinal = 0;
  // @ts-ignore — written for future deduplication but not yet read
  private _lastPacketId = -1;
  private _staleCount = 0;
  private _loggedWaiting = false;

  // Lazily loaded FFI handles
  private _kernel32: Kernel32 | null = null;
  private _ffiPtr: ((buf: Buffer) => unknown) | null = null;
  // @ts-ignore — stored for potential future buffer reads
  private _ffiToBuffer: ((view: number, offset: number, size: number) => Uint8Array) | null = null;

  get connected(): boolean {
    return this._connected;
  }

  get running(): boolean {
    return this._running;
  }

  /** Read current raw buffers for debugging. Returns null if not connected. */
  getDebugBuffers(): { physics: Buffer; graphics: Buffer; staticData: Buffer } | null {
    if (!this._connected || !this._physics || !this._graphics || !this._static || !this._kernel32) {
      return null;
    }
    return {
      physics: this._readMapped(this._physics),
      graphics: this._readMapped(this._graphics),
      staticData: this._readMapped(this._static),
    };
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    console.log("[ACC] Starting shared memory reader...");
    this._tryConnect();
    // Retry every 10s until ACC is detected and connected
    if (!this._retryTimer) {
      this._retryTimer = setInterval(() => {
        if (!this._connected) this._tryConnect();
      }, 10_000);
    }
  }

  stop(): void {
    this._running = false;
    this._disconnect();
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._retryTimer) {
      clearInterval(this._retryTimer);
      this._retryTimer = null;
    }
    console.log("[ACC] Shared memory reader stopped");
  }

  private _loadFfi(): boolean {
    if (this._kernel32) return true;
    try {
      const { dlopen, FFIType, ptr, toBuffer } = require("bun:ffi") as typeof import("bun:ffi");
      this._kernel32 = dlopen("kernel32.dll", {
        OpenFileMappingW: {
          args: [FFIType.u32, FFIType.bool, FFIType.ptr],
          returns: FFIType.ptr,
        },
        MapViewOfFile: {
          args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32],
          returns: FFIType.ptr,
        },
        UnmapViewOfFile: {
          args: [FFIType.ptr],
          returns: FFIType.bool,
        },
        CloseHandle: {
          args: [FFIType.ptr],
          returns: FFIType.bool,
        },
        // Safe memcpy from mapped memory into a JS buffer
        RtlCopyMemory: {
          args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
          returns: FFIType.void,
        },
      }) as Kernel32;
      this._ffiPtr = ptr as (buf: Buffer) => unknown;
      this._ffiToBuffer = toBuffer as unknown as (view: number, offset: number, size: number) => Uint8Array;
      return true;
    } catch (err) {
      console.error("[ACC] Failed to load kernel32.dll via FFI:", err);
      return false;
    }
  }

  /** Safely copy bytes from a mapped view into a new Buffer using RtlCopyMemory */
  private _readMapped(mapped: MappedFile): Buffer {
    const dest = Buffer.alloc(mapped.size);
    this._kernel32!.symbols.RtlCopyMemory(
      this._ffiPtr!(dest),
      mapped.view,
      mapped.size
    );
    return dest;
  }

  private _tryConnect(): void {
    if (!this._running) return;

    // Check if ACC process is running before touching shared memory
    if (!isGameRunning("acc")) {
      if (!this._loggedWaiting) {
        console.log("[ACC] Waiting for ACC process...");
        this._loggedWaiting = true;
      }
      return;
    }
    this._loggedWaiting = false;

    if (!this._loadFfi()) {
      this._running = false;
      return;
    }

    this._physics = openSharedMemory(
      this._kernel32!,
      this._ffiPtr!,
      "Local\\acpmf_physics",
      PHYSICS.SIZE
    );
    this._graphics = openSharedMemory(
      this._kernel32!,
      this._ffiPtr!,
      "Local\\acpmf_graphics",
      GRAPHICS.SIZE
    );
    this._static = openSharedMemory(
      this._kernel32!,
      this._ffiPtr!,
      "Local\\acpmf_static",
      STATIC.SIZE
    );

    if (this._physics && this._graphics && this._static) {
      try {
        const graphicsCheck = this._readMapped(this._graphics);
        const status = graphicsCheck.readInt32LE(GRAPHICS.status.offset);
        if (status === AC_STATUS.AC_OFF) {
          this._disconnect();
          return;
        }
      } catch (err) {
        console.error("[ACC] Shared memory not readable, will retry...", err);
        this._disconnect();
        return;
      }

      this._connected = true;
      this._lastPacketId = -1;
      this._staleCount = 0;

      // Resolve car/track ordinals from static shared memory strings
      try {
        const staticCheck = this._readMapped(this._static);
        const carModel = readWString(staticCheck, STATIC.carModel.offset, STATIC.carModel.size);
        const trackStr = readWString(staticCheck, STATIC.track.offset, STATIC.track.size);

        const { getAccCarByModel } = require("../../../shared/acc-car-data") as typeof import("../../../shared/acc-car-data");
        const { getAccTrackByName } = require("../../../shared/acc-track-data") as typeof import("../../../shared/acc-track-data");

        const car = getAccCarByModel(carModel);
        this._carOrdinal = car?.id ?? 0;

        const track = getAccTrackByName(trackStr);
        this._trackOrdinal = track?.id ?? 0;

        console.log(`[ACC] Resolved car: ${carModel} → #${this._carOrdinal}, track: ${trackStr} → #${this._trackOrdinal}`);
      } catch (err) {
        console.error("[ACC] Failed to resolve car/track ordinals:", err);
      }

      console.log("[ACC] Connected to shared memory");
      this._pollTimer = setInterval(() => this._poll(), 1000 / 60);
      if (this._retryTimer) {
        clearInterval(this._retryTimer);
        this._retryTimer = null;
      }
    } else {
      this._disconnect();
    }
  }

  private _disconnect(): void {
    const k32 = this._kernel32;
    if (k32) {
      if (this._physics) {
        closeSharedMemory(k32, this._physics);
        this._physics = null;
      }
      if (this._graphics) {
        closeSharedMemory(k32, this._graphics);
        this._graphics = null;
      }
      if (this._static) {
        closeSharedMemory(k32, this._static);
        this._static = null;
      }
    }
    if (this._connected) {
      this._connected = false;
      console.log("[ACC] Disconnected from shared memory");
    }
  }

  private async _poll(): Promise<void> {
    if (!this._physics || !this._graphics || !this._static) return;

    try {
      const physicsBuf = this._readMapped(this._physics);
      const graphicsBuf = this._readMapped(this._graphics);

      const status = graphicsBuf.readInt32LE(GRAPHICS.status.offset);
      if (status !== AC_STATUS.AC_LIVE) {
        if (status === AC_STATUS.AC_OFF) {
          this._disconnect();
          if (!this._retryTimer) {
            this._retryTimer = setInterval(() => this._tryConnect(), 2000);
          }
          if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = null;
          }
        }
        return;
      }

      // Periodically verify ACC is still running (~every 5s = 300 polls at 60Hz)
      this._staleCount++;
      if (this._staleCount >= 300) {
        this._staleCount = 0;
        if (!isGameRunning("acc")) {
          console.log("[ACC] ACC process no longer running, disconnecting");
          this._disconnect();
          if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = null; }
          if (!this._retryTimer) { this._retryTimer = setInterval(() => this._tryConnect(), 5000); }
          return;
        }
      }

      const staticBuf = this._readMapped(this._static);

      // Record raw buffers if recording is active
      if (accRecorder.recording) {
        accRecorder.writeFrame(physicsBuf, graphicsBuf, staticBuf);
      }

      // Dynamically import parser to avoid hard dependency at module load time
      const { parseAccBuffers } = require("./parser") as typeof import("./parser");
      const packet = parseAccBuffers(physicsBuf, graphicsBuf, staticBuf, {
        carOrdinal: this._carOrdinal,
        trackOrdinal: this._trackOrdinal,
      });
      if (packet) {
        await processPacket(packet);
      }
    } catch (err) {
      console.error("[ACC] Error reading shared memory:", err);
      this._disconnect();
      if (this._pollTimer) {
        clearInterval(this._pollTimer);
        this._pollTimer = null;
      }
      if (!this._retryTimer) {
        this._retryTimer = setInterval(() => this._tryConnect(), 2000);
      }
    }
  }
}

export const accReader = new AccSharedMemoryReader();
