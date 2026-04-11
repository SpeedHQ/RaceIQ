/**
 * Buffered ACC memory reader with realistic update rates.
 *
 * Reads each buffer at its native rate:
 * - Physics: 300Hz (every ~3.3ms)
 * - Graphics: 60Hz (every ~16.7ms)
 * - Static: once per session
 *
 * Buffers are then polled synchronously by TripletAssembler at 100Hz
 * to create deterministic triplets for processing.
 */

import type { IRealtimeAccMemoryReader } from "./memory-reader";

interface MappedFile {
  handle: number;
  view: number;
  size: number;
}

export class BufferedAccMemoryReader implements IRealtimeAccMemoryReader {
  private _physics: MappedFile | null = null;
  private _graphics: MappedFile | null = null;
  private _static: MappedFile | null = null;

  // Buffered data
  private _physicsBuffer: Buffer | null = null;
  private _graphicsBuffer: Buffer | null = null;
  private _staticBuffer: Buffer | null = null;

  // Poll timers
  private _physicsTimer: ReturnType<typeof setInterval> | null = null; // 300Hz
  private _graphicsTimer: ReturnType<typeof setInterval> | null = null; // 60Hz
  private _retryTimer: ReturnType<typeof setInterval> | null = null;

  private _running = false;
  private _connected = false;
  private _kernel32: any = null;
  private _ffiPtr: ((buf: Buffer) => unknown) | null = null;
  // Session detection for smart static re-reading
  private _lastSessionId: number | null = null;

  connected(): boolean {
    return this._connected;
  }

  running(): boolean {
    return this._running;
  }

  getDebugBuffers(): { physics: Buffer; graphics: Buffer; staticData: Buffer } | null {
    if (!this._physicsBuffer || !this._graphicsBuffer || !this._staticBuffer) {
      return null;
    }
    return {
      physics: this._physicsBuffer,
      graphics: this._graphicsBuffer,
      staticData: this._staticBuffer,
    };
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this._tryConnect();

    // Retry connection every 10s
    if (!this._retryTimer) {
      this._retryTimer = setInterval(() => {
        if (!this._connected) this._tryConnect();
      }, 10000);
    }
  }

  async stop(): Promise<void> {
    this._running = false;
    this._disconnect();

    if (this._physicsTimer) {
      clearInterval(this._physicsTimer);
      this._physicsTimer = null;
    }
    if (this._graphicsTimer) {
      clearInterval(this._graphicsTimer);
      this._graphicsTimer = null;
    }
    if (this._retryTimer) {
      clearInterval(this._retryTimer);
      this._retryTimer = null;
    }

    console.log("[ACC Buffered Reader] Stopped");
  }

  /** Get latest buffers (for TripletAssembler to poll) */
  getLatestBuffers(): {
    physics: Buffer | null;
    graphics: Buffer | null;
    staticData: Buffer | null;
  } {
    return {
      physics: this._physicsBuffer,
      graphics: this._graphicsBuffer,
      staticData: this._staticBuffer,
    };
  }

  nextFrame(): { physics?: Buffer; graphics?: Buffer; staticData?: Buffer } | null {
    // Not used — TripletAssembler polls directly
    return null;
  }

  private _tryConnect(): void {
    if (!this._running || this._connected) return;

    try {
      // Load FFI if needed
      if (!this._kernel32) {
        const { dlopen, FFIType, ptr } = require("bun:ffi");
        this._kernel32 = dlopen("kernel32.dll", {
          OpenFileMappingW: {
            args: [FFIType.u32, FFIType.bool, FFIType.ptr],
            returns: FFIType.ptr,
          },
          MapViewOfFile: {
            args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32],
            returns: FFIType.ptr,
          },
          UnmapViewOfFile: { args: [FFIType.ptr], returns: FFIType.bool },
          CloseHandle: { args: [FFIType.ptr], returns: FFIType.bool },
          RtlCopyMemory: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.void },
        });
        this._ffiPtr = ptr;
      }

      // Open shared memory regions
      const { PHYSICS, GRAPHICS, STATIC } = require("./structs");
      const FILE_MAP_READ = 0x0004;

      const physicsHandle = this._kernel32.symbols.OpenFileMappingW(
        FILE_MAP_READ,
        false,
        this._ffiPtr!(Buffer.from("Local\\acpmf_physics\0", "utf16le"))
      );
      const graphicsHandle = this._kernel32.symbols.OpenFileMappingW(
        FILE_MAP_READ,
        false,
        this._ffiPtr!(Buffer.from("Local\\acpmf_graphics\0", "utf16le"))
      );
      const staticHandle = this._kernel32.symbols.OpenFileMappingW(
        FILE_MAP_READ,
        false,
        this._ffiPtr!(Buffer.from("Local\\acpmf_static\0", "utf16le"))
      );

      if (!physicsHandle || !graphicsHandle || !staticHandle) {
        return;
      }

      // Map views
      const physicsView = this._kernel32.symbols.MapViewOfFile(physicsHandle, FILE_MAP_READ, 0, 0, 0);
      const graphicsView = this._kernel32.symbols.MapViewOfFile(graphicsHandle, FILE_MAP_READ, 0, 0, 0);
      const staticView = this._kernel32.symbols.MapViewOfFile(staticHandle, FILE_MAP_READ, 0, 0, 0);

      if (!physicsView || !graphicsView || !staticView) {
        this._kernel32.symbols.CloseHandle(physicsHandle);
        this._kernel32.symbols.CloseHandle(graphicsHandle);
        this._kernel32.symbols.CloseHandle(staticHandle);
        return;
      }

      this._physics = { handle: Number(physicsHandle), view: Number(physicsView), size: PHYSICS.SIZE };
      this._graphics = {
        handle: Number(graphicsHandle),
        view: Number(graphicsView),
        size: GRAPHICS.SIZE,
      };
      this._static = { handle: Number(staticHandle), view: Number(staticView), size: STATIC.SIZE };

      this._connected = true;
      console.log("[ACC Buffered Reader] Connected to shared memory");

      // Start polling at native rates
      this._startPolling();
    } catch (e) {
      console.error("[ACC Buffered Reader] Connection failed:", e);
      this._disconnect();
    }
  }

  private _startPolling(): void {
    // Physics at 300Hz (every 3.33ms)
    this._physicsTimer = setInterval(() => {
      if (this._physics) {
        this._physicsBuffer = this._readMapped(this._physics);
      }
    }, 1000 / 300);

    // Graphics at 60Hz (every 16.67ms)
    this._graphicsTimer = setInterval(() => {
      if (this._graphics) {
        this._graphicsBuffer = this._readMapped(this._graphics);

        // Check if session changed (offset 8 in graphics buffer)
        // Only re-read expensive static buffer on session change
        const currentSessionId = this._graphicsBuffer.readInt32LE(8);
        if (this._lastSessionId !== currentSessionId && this._static) {
          this._staticBuffer = this._readMapped(this._static);
          this._lastSessionId = currentSessionId;
        }
      }
    }, 1000 / 60);
  }

  private _readMapped(mapped: MappedFile): Buffer {
    const start = Date.now();
    const dest = Buffer.alloc(mapped.size);
    this._kernel32.symbols.RtlCopyMemory(this._ffiPtr!(dest), mapped.view, mapped.size);
    const duration = Date.now() - start;

    // Log if read takes >5ms (indicates real contention, normal reads are 1-2ms)
    if (duration > 5) {
      console.warn(`[ACC Buffered Reader] Slow read: ${duration}ms for ${mapped.size} bytes`);
    }

    return dest;
  }

  private _disconnect(): void {
    const k32 = this._kernel32;
    if (k32) {
      if (this._physics) {
        k32.symbols.UnmapViewOfFile(this._physics.view);
        k32.symbols.CloseHandle(this._physics.handle);
        this._physics = null;
      }
      if (this._graphics) {
        k32.symbols.UnmapViewOfFile(this._graphics.view);
        k32.symbols.CloseHandle(this._graphics.handle);
        this._graphics = null;
      }
      if (this._static) {
        k32.symbols.UnmapViewOfFile(this._static.view);
        k32.symbols.CloseHandle(this._static.handle);
        this._static = null;
      }
    }
    this._connected = false;
  }
}
