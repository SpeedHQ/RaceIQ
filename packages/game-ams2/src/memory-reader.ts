import type * as BunFFI from "bun:ffi";
import { AMS2_MAPPING_NAME, AMS2_MEMORY_SIZE, AMS2_LAYOUT } from "./layout";
import { AMS2_MAX_MEMORY_BYTES } from "@raceiq/capture-formats/ams2/dump";

interface MappedHandles {
  dataHandle: number;
  dataView: number;
}

type NativePointer = number | bigint | null;

interface Kernel32Symbols {
  OpenFileMappingW(access: number, inherit: boolean, name: number): NativePointer;
  MapViewOfFile(handle: NativePointer, access: number, offsetHigh: number, offsetLow: number, size: number): NativePointer;
  UnmapViewOfFile(view: NativePointer): boolean;
  CloseHandle(handle: NativePointer): boolean;
  RtlCopyMemory(destination: number, source: NativePointer, size: number): void;
  VirtualQuery(address: NativePointer, information: number, size: number): number | bigint;
}

interface Kernel32Library {
  symbols: Kernel32Symbols;
}

export interface AMS2ReadDiagnostics {
  disconnected: number;
  writerBusy: number;
  sequenceChanged: number;
  bytesChanged: number;
  accepted: number;
}

/** Bun FFI reader for AMS2's PCars2 mapping. */
export class AMS2SharedMemoryReader {
  private kernel32: Kernel32Library | null = null;
  private ffiPointer: typeof BunFFI.ptr | null = null;
  private mapped: MappedHandles | null = null;
  private snapshot = Buffer.allocUnsafe(AMS2_MEMORY_SIZE);
  private verificationSnapshot = Buffer.allocUnsafe(AMS2_MEMORY_SIZE);
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly mappingName: string;

  constructor(mappingName = AMS2_MAPPING_NAME) {
    this.mappingName = mappingName;
  }

  private readonly diagnostics: AMS2ReadDiagnostics = {
    disconnected: 0, writerBusy: 0, sequenceChanged: 0, bytesChanged: 0, accepted: 0,
  };

  getDiagnostics(): AMS2ReadDiagnostics { return { ...this.diagnostics }; }

  get connected(): boolean {
    return this.mapped !== null;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tryConnect();
    this.retryTimer = setInterval(() => this.tryConnect(), 2_000);
    this.retryTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
    this.disconnect();
  }

  readLatest(): Buffer | null {
    const mapped = this.mapped;
    if (!mapped || !this.kernel32 || !this.ffiPointer) {
      this.diagnostics.disconnected++;
      return null;
    }

    // Require identical full snapshots with the same even writer sequence.
    const sequence = AMS2_LAYOUT.mSequenceNumber;
    this.copyMappedMemory(this.snapshot, mapped.dataView);
    const before = this.snapshot.readUInt32LE(sequence);
    if (before & 1) { this.diagnostics.writerBusy++; return null; }
    this.copyMappedMemory(this.verificationSnapshot, mapped.dataView);
    if (this.verificationSnapshot.readUInt32LE(sequence) !== before) {
      this.diagnostics.sequenceChanged++;
      return null;
    }
    if (!this.snapshot.equals(this.verificationSnapshot)) {
      this.diagnostics.bytesChanged++;
      return null;
    }
    this.diagnostics.accepted++;
    // The returned buffer is immutable; later polls must not overwrite queued frames.
    return Buffer.from(this.snapshot);
  }

  private copyMappedMemory(destination: Buffer, source: number): void {
    this.kernel32!.symbols.RtlCopyMemory(this.ffiPointer!(destination), source, destination.length);
  }

  private loadKernel32(): void {
    if (this.kernel32) return;
    const { dlopen, FFIType, ptr } = require("bun:ffi") as typeof BunFFI;
    const library = dlopen("kernel32.dll", {
      OpenFileMappingW: {
        args: [FFIType.u32, FFIType.bool, FFIType.ptr],
        returns: FFIType.ptr,
      },
      MapViewOfFile: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u64],
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
      RtlCopyMemory: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
        returns: FFIType.void,
      },
      VirtualQuery: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
        returns: FFIType.u64,
      },
    });
    // bun:ffi builds symbol methods from declarations above; this named cast
    // keeps unsafe native boundary isolated from reader state.
    this.kernel32 = library as unknown as Kernel32Library;
    this.ffiPointer = ptr;
  }

  private tryConnect(): void {
    if (!this.running || this.mapped) return;
    try {
      this.loadKernel32();
      const kernel32 = this.kernel32;
      const pointer = this.ffiPointer;
      if (!kernel32 || !pointer) return;

      const FILE_MAP_READ = 0x0004;
      const dataHandle = kernel32.symbols.OpenFileMappingW(FILE_MAP_READ, false, pointer(Buffer.from(`${this.mappingName}\0`, "utf16le")));
      if (!dataHandle) return;

      const dataView = kernel32.symbols.MapViewOfFile(dataHandle, FILE_MAP_READ, 0, 0, 0);
      if (!dataView) {
        kernel32.symbols.CloseHandle(dataHandle);
        return;
      }

      this.mapped = {
        dataHandle: Number(dataHandle),
        dataView: Number(dataView),
      };
      // Windows x64 MEMORY_BASIC_INFORMATION; capture the full readable view,
      // including extension fields and page padding, without guessing ABI size.
      const info = Buffer.alloc(48);
      const queried = Number(kernel32.symbols.VirtualQuery(dataView, pointer(info), info.length));
      const regionBytes = Number(info.readBigUInt64LE(24));
      if (
        process.arch !== "x64" ||
        queried < 48 ||
        info.readBigUInt64LE(0) !== BigInt(dataView) ||
        info.readUInt32LE(32) !== 0x1000 ||
        info.readUInt32LE(40) !== 0x40000 ||
        (info.readUInt32LE(36) & 0x101) !== 0 ||
        regionBytes < AMS2_MEMORY_SIZE ||
        regionBytes > AMS2_MAX_MEMORY_BYTES
      ) {
        throw new Error("Unsupported AMS2 mapping region or platform");
      }
      this.snapshot = Buffer.allocUnsafe(regionBytes);
      this.verificationSnapshot = Buffer.allocUnsafe(regionBytes);
      console.log(`[AMS2] Connected to PCars2 shared memory (${regionBytes} bytes)`);
    } catch (error) {
      console.error("[AMS2] Shared memory connection failed:", error instanceof Error ? error.message : error);
      this.disconnect();
    }
  }

  private disconnect(): void {
    const mapped = this.mapped;
    if (!mapped || !this.kernel32) return;
    this.kernel32.symbols.UnmapViewOfFile(mapped.dataView);
    this.kernel32.symbols.CloseHandle(mapped.dataHandle);
    this.mapped = null;
  }
}
