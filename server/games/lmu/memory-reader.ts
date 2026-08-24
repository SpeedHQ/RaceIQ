import type * as BunFFI from "bun:ffi";
import {
  LMU_MAX_VEHICLES,
  LMU_MAPPING_NAME,
  LMU_SCORING_INFO,
  LMU_SCORING_INFO_OFFSET,
  LMU_SCORING_VEHICLE_SIZE,
  LMU_SCORING_VEHICLES_OFFSET,
  LMU_SHARED_MEMORY_SIZE,
  LMU_TELEMETRY_HEADER_OFFSET,
  LMU_TELEMETRY_INFO_OFFSET,
  LMU_TELEMETRY_INFO_SIZE,
} from "./layout";

interface MappedHandles {
  dataHandle: number;
  dataView: number;
}

type NativePointer = number | bigint | null;

interface Kernel32Symbols {
  OpenFileMappingW(access: number, inherit: boolean, name: number): NativePointer;
  MapViewOfFile(
    handle: NativePointer,
    access: number,
    offsetHigh: number,
    offsetLow: number,
    size: number,
  ): NativePointer;
  UnmapViewOfFile(view: NativePointer): boolean;
  CloseHandle(handle: NativePointer): boolean;
  RtlCopyMemory(destination: number, source: NativePointer, size: number): void;
}

interface Kernel32Library {
  symbols: Kernel32Symbols;
}

/** Bun FFI reader for Studio 397's built-in LMU_Data mapping. */
export class LMUSharedMemoryReader {
  private kernel32: Kernel32Library | null = null;
  private ffiPointer: typeof BunFFI.ptr | null = null;
  private mapped: MappedHandles | null = null;
  private readonly snapshot = Buffer.allocUnsafe(LMU_SHARED_MEMORY_SIZE);
  private readonly verificationSnapshot = Buffer.allocUnsafe(
    LMU_SHARED_MEMORY_SIZE,
  );
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;

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
    if (!mapped || !this.kernel32 || !this.ffiPointer) return null;

    // Bun FFI cannot call Windows Interlocked* intrinsics used by Studio 397's
    // C++ sample lock. Two back-to-back copies plus equality checks over every
    // consumed region reject snapshots modified during capture without blocking
    // Bun's main thread on LMU's event or lock.
    this.copyMappedMemory(this.snapshot, mapped.dataView);
    this.copyMappedMemory(this.verificationSnapshot, mapped.dataView);
    return this.consumedRegionsMatch() ? this.snapshot : null;
  }

  private copyMappedMemory(destination: Buffer, source: number): void {
    this.kernel32!.symbols.RtlCopyMemory(
      this.ffiPointer!(destination),
      source,
      LMU_SHARED_MEMORY_SIZE,
    );
  }

  private consumedRegionsMatch(): boolean {
    const first = this.snapshot;
    const second = this.verificationSnapshot;
    if (!first.subarray(0, 72).equals(second.subarray(0, 72))) return false;

    const vehicleCount = first.readInt32LE(
      LMU_SCORING_INFO_OFFSET + LMU_SCORING_INFO.numberOfVehicles,
    );
    if (vehicleCount < 0 || vehicleCount > LMU_MAX_VEHICLES) return false;
    const scoringEnd =
      LMU_SCORING_VEHICLES_OFFSET +
      vehicleCount * LMU_SCORING_VEHICLE_SIZE;
    if (
      !first
        .subarray(LMU_SCORING_INFO_OFFSET, scoringEnd)
        .equals(second.subarray(LMU_SCORING_INFO_OFFSET, scoringEnd))
    ) {
      return false;
    }

    const firstHeader = first.subarray(
      LMU_TELEMETRY_HEADER_OFFSET,
      LMU_TELEMETRY_INFO_OFFSET,
    );
    const secondHeader = second.subarray(
      LMU_TELEMETRY_HEADER_OFFSET,
      LMU_TELEMETRY_INFO_OFFSET,
    );
    if (!firstHeader.equals(secondHeader)) return false;
    const activeVehicles = first.readUInt8(LMU_TELEMETRY_HEADER_OFFSET);
    const playerIndex = first.readUInt8(LMU_TELEMETRY_HEADER_OFFSET + 1);
    const playerHasVehicle =
      first.readUInt8(LMU_TELEMETRY_HEADER_OFFSET + 2) !== 0;
    if (
      !playerHasVehicle ||
      activeVehicles === 0 ||
      activeVehicles > LMU_MAX_VEHICLES ||
      playerIndex >= activeVehicles
    ) {
      return false;
    }
    const telemetryStart =
      LMU_TELEMETRY_INFO_OFFSET + playerIndex * LMU_TELEMETRY_INFO_SIZE;
    const telemetryEnd = telemetryStart + LMU_TELEMETRY_INFO_SIZE;
    return first
      .subarray(telemetryStart, telemetryEnd)
      .equals(second.subarray(telemetryStart, telemetryEnd));
  }

  private loadKernel32(): void {
    if (this.kernel32) return;
    const { dlopen, FFIType, ptr } =
      require("bun:ffi") as typeof BunFFI;
    const library = dlopen("kernel32.dll", {
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
      RtlCopyMemory: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u64],
        returns: FFIType.void,
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
      const dataHandle = kernel32.symbols.OpenFileMappingW(
        FILE_MAP_READ,
        false,
        pointer(Buffer.from(`${LMU_MAPPING_NAME}\0`, "utf16le")),
      );
      if (!dataHandle) return;

      const dataView = kernel32.symbols.MapViewOfFile(
        dataHandle,
        FILE_MAP_READ,
        0,
        0,
        LMU_SHARED_MEMORY_SIZE,
      );
      if (!dataView) {
        kernel32.symbols.CloseHandle(dataHandle);
        return;
      }

      this.mapped = {
        dataHandle: Number(dataHandle),
        dataView: Number(dataView),
      };
      console.log("[LMU] Connected to LMU_Data shared memory");
    } catch (error) {
      console.error(
        "[LMU] Shared memory connection failed:",
        error instanceof Error ? error.message : error,
      );
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
