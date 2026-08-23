import type { IRacingValue } from "./source-frame";
import { IRacingVariableTable, IRSDK_VAR_HEADER_SIZE } from "./variable-table";

const IRSDK_MEMORY_MAP_NAME = "Local\\IRSDKMemMapFileName";
const IRSDK_HEADER_SIZE = 112;
const IRSDK_MAX_BUFFERS = 4;
const IRSDK_CONNECTED = 1;
const FILE_MAP_READ = 0x0004;

const MAX_VARIABLES = 4096;
const MAX_BUFFER_LENGTH = 4 * 1024 * 1024;
const MAX_SESSION_INFO_LENGTH = 4 * 1024 * 1024;
const MAX_MAPPING_OFFSET = 64 * 1024 * 1024;
// 64-bit Windows MEMORY_BASIC_INFORMATION layout used by Bun x64/arm64.
const MEMORY_BASIC_INFORMATION_SIZE = 48;
const MEMORY_BASIC_INFORMATION_BASE_ADDRESS_OFFSET = 0;
const MEMORY_BASIC_INFORMATION_REGION_SIZE_OFFSET = 24;

export const IRACING_TELEMETRY_VARIABLES = [
  "SessionTime",
  "SessionTick",
  "SessionUniqueID",
  "SessionNum",
  "SessionState",
  "IsOnTrack",
  "OnPitRoad",
  "PlayerTrackSurface",
  "PlayerIncidents",
  "PlayerCarPosition",
  "Speed",
  "RPM",
  "Throttle",
  "Brake",
  "Clutch",
  "Gear",
  "SteeringWheelAngle",
  "SteeringWheelAngleMax",
  "FuelLevel",
  "Lap",
  "LapCompleted",
  "CarIdxLap",
  "CarIdxLastLapTime",
  "CarIdxBestLapTime",
  "CarIdxTrackSurface",
  "CarLeftRight",
  "LapDist",
  "LapDistPct",
  "LapBestLapTime",
  "LapLastLapTime",
  "LapCurrentLapTime",
  "LatAccel",
  "LongAccel",
  "VertAccel",
  "VelocityX",
  "VelocityY",
  "VelocityZ",
  "Yaw",
  "Pitch",
  "Roll",
  "YawRate",
  "PitchRate",
  "RollRate",
  "TrackTemp",
  "AirTemp",
  "Precipitation",
  "TrackWetness",
  "LFshockDefl",
  "RFshockDefl",
  "LRshockDefl",
  "RRshockDefl",
  "LFtempCL",
  "LFtempCM",
  "LFtempCR",
  "RFtempCL",
  "RFtempCM",
  "RFtempCR",
  "LRtempCL",
  "LRtempCM",
  "LRtempCR",
  "RRtempCL",
  "RRtempCM",
  "RRtempCR",
  "LFwearL",
  "LFwearM",
  "LFwearR",
  "RFwearL",
  "RFwearM",
  "RFwearR",
  "LRwearL",
  "LRwearM",
  "LRwearR",
  "RRwearL",
  "RRwearM",
  "RRwearR",
  "LFcoldPressure",
  "RFcoldPressure",
  "LRcoldPressure",
  "RRcoldPressure",
] as const;

interface IRacingDataBufferHeader {
  tickCount: number;
  offset: number;
}

interface IRacingSdkHeader {
  version: number;
  status: number;
  sessionInfoUpdate: number;
  sessionInfoLength: number;
  sessionInfoOffset: number;
  variableCount: number;
  variableHeaderOffset: number;
  bufferCount: number;
  bufferLength: number;
  buffers: IRacingDataBufferHeader[];
}

export interface IRacingSdkSnapshot {
  tick: number;
  sessionInfoUpdate: number;
  sessionInfo: string;
  values: Record<string, IRacingValue>;
}

function parseHeader(buf: Buffer): IRacingSdkHeader | null {
  if (buf.length < IRSDK_HEADER_SIZE) return null;

  const bufferCount = buf.readInt32LE(32);
  const buffers: IRacingDataBufferHeader[] = [];
  const boundedBufferCount = Math.min(Math.max(bufferCount, 0), IRSDK_MAX_BUFFERS);
  for (let index = 0; index < boundedBufferCount; index++) {
    const offset = 48 + index * 16;
    buffers.push({
      tickCount: buf.readInt32LE(offset),
      offset: buf.readInt32LE(offset + 4),
    });
  }

  return {
    version: buf.readInt32LE(0),
    status: buf.readInt32LE(4),
    sessionInfoUpdate: buf.readInt32LE(12),
    sessionInfoLength: buf.readInt32LE(16),
    sessionInfoOffset: buf.readInt32LE(20),
    variableCount: buf.readInt32LE(24),
    variableHeaderOffset: buf.readInt32LE(28),
    bufferCount,
    bufferLength: buf.readInt32LE(36),
    buffers,
  };
}

export function isValidIRacingMappingRange(
  offset: number,
  length: number,
  mappingSize: number,
): boolean {
  const end = offset + length;
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    Number.isSafeInteger(mappingSize) &&
    Number.isSafeInteger(end) &&
    offset >= 0 &&
    length > 0 &&
    mappingSize >= IRSDK_HEADER_SIZE &&
    end <= mappingSize &&
    end <= MAX_MAPPING_OFFSET
  );
}

function validRange(
  offset: number,
  length: number,
  maxLength: number,
  mappingSize: number,
): boolean {
  return (
    length <= maxLength &&
    isValidIRacingMappingRange(offset, length, mappingSize)
  );
}

function isUsableHeader(
  header: IRacingSdkHeader,
  mappingSize: number,
): boolean {
  return (
    header.version > 0 &&
    header.bufferCount > 0 &&
    header.bufferCount <= IRSDK_MAX_BUFFERS &&
    header.variableCount > 0 &&
    header.variableCount <= MAX_VARIABLES &&
    validRange(
      header.variableHeaderOffset,
      header.variableCount * IRSDK_VAR_HEADER_SIZE,
      MAX_VARIABLES * IRSDK_VAR_HEADER_SIZE,
      mappingSize,
    ) &&
    validRange(
      header.sessionInfoOffset,
      header.sessionInfoLength,
      MAX_SESSION_INFO_LENGTH,
      mappingSize,
    ) &&
    header.bufferLength > 0 &&
    header.bufferLength <= MAX_BUFFER_LENGTH &&
    header.buffers.every((entry) =>
      validRange(
        entry.offset,
        header.bufferLength,
        MAX_BUFFER_LENGTH,
        mappingSize,
      ),
    )
  );
}

/**
 * Direct reader for the official iRacing Windows shared-memory SDK.
 *
 * No third-party SDK wrapper is involved. RaceIQ maps IRSDKMemMapFileName,
 * parses the published header/variable descriptors, and copies the newest
 * stable telemetry row itself.
 */
export class IRacingSdkReader {
  private _running = false;
  private _connected = false;
  private _kernel32: any = null;
  private _ffiPtr: ((buf: Buffer) => unknown) | null = null;
  private _mappingHandle = 0n;
  private _mappingView = 0n;
  private _mappingSize = 0;
  private _variableTable: IRacingVariableTable | null = null;
  private _tableSignature = "";
  private _sessionInfo = "";
  private _sessionInfoUpdate = -1;
  private _lastTick: number | null = null;
  private _nextConnectAttemptAt = 0;

  get connected(): boolean {
    return this._connected;
  }

  start(): void {
    if (this._running) return;
    if (process.platform !== "win32") {
      throw new Error("The iRacing SDK shared-memory source is only available on Windows");
    }
    this._running = true;
    this._tryConnect();
  }

  async stop(): Promise<void> {
    this._running = false;
    this._disconnect();
  }

  readLatest(): IRacingSdkSnapshot | null {
    if (!this._running) return null;
    if (!this._connected) {
      this._tryConnect();
      if (!this._connected) return null;
    }

    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const before = this._readHeader();
        if (!before || !isUsableHeader(before, this._mappingSize)) {
          this._disconnect();
          return null;
        }
        if ((before.status & IRSDK_CONNECTED) === 0) return null;

        this._refreshMetadata(before);
        if (!this._variableTable || !this._sessionInfo) return null;

        const newest = before.buffers.reduce((best, candidate) =>
          candidate.tickCount > best.tickCount ? candidate : best,
        );
        if (this._lastTick === newest.tickCount) return null;

        const row = this._copy(newest.offset, before.bufferLength);
        const after = this._readHeader();
        const sameSlot = after?.buffers.find((entry) => entry.offset === newest.offset);
        if (
          !after ||
          after.sessionInfoUpdate !== before.sessionInfoUpdate ||
          !sameSlot ||
          sameSlot.tickCount !== newest.tickCount
        ) {
          continue;
        }

        const values = this._variableTable.readAll(row);
        this._lastTick = newest.tickCount;
        return {
          tick: newest.tickCount,
          sessionInfoUpdate: before.sessionInfoUpdate,
          sessionInfo: this._sessionInfo,
          values,
        };
      }
    } catch (error) {
      console.error(
        "[iRacing SDK] Shared-memory read failed:",
        error instanceof Error ? error.message : error,
      );
      this._disconnect();
    }

    return null;
  }

  private _tryConnect(): void {
    if (!this._running || this._connected || Date.now() < this._nextConnectAttemptAt) return;
    this._nextConnectAttemptAt = Date.now() + 2000;

    try {
      if (!this._kernel32) {
        // Platform-specific exception to the static-import rule: bun:ffi cannot
        // be resolved in non-Bun tooling and this source only exists on Windows.
        const { dlopen, FFIType, ptr } = require("bun:ffi");
        this._kernel32 = dlopen("kernel32.dll", {
          OpenFileMappingW: {
            args: [FFIType.u32, FFIType.bool, FFIType.ptr],
            returns: FFIType.u64,
          },
          MapViewOfFile: {
            args: [FFIType.u64, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32],
            returns: FFIType.u64,
          },
          VirtualQuery: {
            args: [FFIType.u64, FFIType.ptr, FFIType.u64],
            returns: FFIType.u64,
          },
          UnmapViewOfFile: { args: [FFIType.u64], returns: FFIType.bool },
          CloseHandle: { args: [FFIType.u64], returns: FFIType.bool },
          RtlCopyMemory: {
            args: [FFIType.ptr, FFIType.u64, FFIType.u64],
            returns: FFIType.void,
          },
        });
        this._ffiPtr = ptr;
      }

      const mapName = Buffer.from(`${IRSDK_MEMORY_MAP_NAME}\0`, "utf16le");
      const handle = this._kernel32.symbols.OpenFileMappingW(
        FILE_MAP_READ,
        false,
        this._ffiPtr!(mapName),
      ) as bigint;
      if (!handle) return;

      const view = this._kernel32.symbols.MapViewOfFile(
        handle,
        FILE_MAP_READ,
        0,
        0,
        0,
      ) as bigint;
      if (!view) {
        this._kernel32.symbols.CloseHandle(handle);
        return;
      }

      this._mappingHandle = handle;
      this._mappingView = view;
      const memoryInfo = Buffer.alloc(MEMORY_BASIC_INFORMATION_SIZE);
      const bytesWritten = Number(
        this._kernel32.symbols.VirtualQuery(
          view,
          this._ffiPtr!(memoryInfo),
          BigInt(memoryInfo.length),
        ),
      );
      if (bytesWritten < MEMORY_BASIC_INFORMATION_SIZE) {
        this._disconnect();
        return;
      }
      const baseAddress = memoryInfo.readBigUInt64LE(
        MEMORY_BASIC_INFORMATION_BASE_ADDRESS_OFFSET,
      );
      const regionSize = Number(
        memoryInfo.readBigUInt64LE(
          MEMORY_BASIC_INFORMATION_REGION_SIZE_OFFSET,
        ),
      );
      if (
        baseAddress !== this._mappingView ||
        !Number.isSafeInteger(regionSize) ||
        regionSize < IRSDK_HEADER_SIZE
      ) {
        this._disconnect();
        return;
      }
      this._mappingSize = regionSize;

      const header = this._readHeader();
      if (!header || !isUsableHeader(header, this._mappingSize)) {
        this._disconnect();
        return;
      }

      this._connected = true;
      console.log("[iRacing SDK] Connected to Local\\IRSDKMemMapFileName");
    } catch (error) {
      console.error(
        "[iRacing SDK] Connection failed:",
        error instanceof Error ? error.message : error,
      );
      this._disconnect();
    }
  }

  private _refreshMetadata(header: IRacingSdkHeader): void {
    const signature = `${header.variableCount}:${header.variableHeaderOffset}:${header.bufferLength}`;
    if (signature !== this._tableSignature) {
      const headerBytes = this._copy(
        header.variableHeaderOffset,
        header.variableCount * IRSDK_VAR_HEADER_SIZE,
      );
      this._variableTable = new IRacingVariableTable(headerBytes, header.bufferLength);
      this._tableSignature = signature;
    }

    if (header.sessionInfoUpdate !== this._sessionInfoUpdate) {
      const sessionBytes = this._copy(
        header.sessionInfoOffset,
        header.sessionInfoLength,
      );
      const nullOffset = sessionBytes.indexOf(0);
      this._sessionInfo = sessionBytes
        .subarray(0, nullOffset >= 0 ? nullOffset : sessionBytes.length)
        .toString("utf8");
      this._sessionInfoUpdate = header.sessionInfoUpdate;
    }
  }

  private _readHeader(): IRacingSdkHeader | null {
    return parseHeader(this._copy(0, IRSDK_HEADER_SIZE));
  }

  private _copy(offset: number, length: number): Buffer {
    if (!this._mappingView || !this._ffiPtr || !this._kernel32) {
      throw new Error("iRacing SDK memory map is not connected");
    }
    if (
      !isValidIRacingMappingRange(
        offset,
        length,
        this._mappingSize,
      )
    ) {
      throw new RangeError(
        `iRacing SDK read [${offset}, ${offset + length}) exceeds ` +
          `mapped region (${this._mappingSize} bytes)`,
      );
    }
    const output = Buffer.allocUnsafe(length);
    this._kernel32.symbols.RtlCopyMemory(
      this._ffiPtr(output),
      this._mappingView + BigInt(offset),
      BigInt(length),
    );
    return output;
  }

  private _disconnect(): void {
    if (this._kernel32) {
      if (this._mappingView) {
        this._kernel32.symbols.UnmapViewOfFile(this._mappingView);
      }
      if (this._mappingHandle) {
        this._kernel32.symbols.CloseHandle(this._mappingHandle);
      }
    }
    if (this._connected) console.log("[iRacing SDK] Disconnected");
    this._mappingHandle = 0n;
    this._mappingView = 0n;
    this._mappingSize = 0;
    this._connected = false;
    this._variableTable = null;
    this._tableSignature = "";
    this._sessionInfo = "";
    this._sessionInfoUpdate = -1;
    this._lastTick = null;
  }
}
