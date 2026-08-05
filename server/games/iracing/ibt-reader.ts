import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  IRACING_TELEMETRY_VARIABLES,
  type IRacingSdkSnapshot,
} from "./sdk-reader";
import {
  IRacingVariableTable,
  IRSDK_VAR_HEADER_SIZE,
} from "./variable-table";

const IRSDK_HEADER_SIZE = 112;
const IRSDK_DISK_SUBHEADER_SIZE = 32;
const IRSDK_DISK_HEADER_SIZE =
  IRSDK_HEADER_SIZE + IRSDK_DISK_SUBHEADER_SIZE;

const MAX_VARIABLES = 4096;
const MAX_BUFFER_LENGTH = 4 * 1024 * 1024;
const MAX_SESSION_INFO_LENGTH = 4 * 1024 * 1024;

export interface IRacingIbtMetadata {
  version: number;
  status: number;
  tickRate: number;
  sessionStartDate: Date;
  sessionStartTime: number;
  sessionEndTime: number;
  lapCount: number;
  recordCount: number;
  rowLength: number;
  dataOffset: number;
  fileSize: number;
  trailingBytes: number;
  missingRaceIQVariables: readonly string[];
}

interface IRacingIbtLayout {
  version: number;
  status: number;
  tickRate: number;
  sessionInfoLength: number;
  sessionInfoOffset: number;
  variableCount: number;
  variableHeaderOffset: number;
  bufferCount: number;
  rowLength: number;
  sessionStartDateSeconds: number;
  sessionStartTime: number;
  sessionEndTime: number;
  lapCount: number;
  recordCount: number;
  dataOffset: number;
  expectedFileSize: number;
}

function readExactly(
  fd: number,
  target: Buffer,
  fileOffset: number,
): void {
  let completed = 0;
  while (completed < target.length) {
    const count = readSync(
      fd,
      target,
      completed,
      target.length - completed,
      fileOffset + completed,
    );
    if (count === 0) {
      throw new Error(
        `Unexpected end of iRacing IBT at byte ${fileOffset + completed}`,
      );
    }
    completed += count;
  }
}

function validFileRange(
  offset: number,
  length: number,
  fileSize: number,
): boolean {
  const end = offset + length;
  return (
    Number.isSafeInteger(offset) &&
    Number.isSafeInteger(length) &&
    Number.isSafeInteger(end) &&
    offset >= 0 &&
    length > 0 &&
    end <= fileSize
  );
}

function parseLayout(header: Buffer, fileSize: number): IRacingIbtLayout {
  if (header.length < IRSDK_DISK_HEADER_SIZE) {
    throw new Error("Invalid iRacing IBT header");
  }

  const version = header.readInt32LE(0);
  const status = header.readInt32LE(4);
  const tickRate = header.readInt32LE(8);
  const sessionInfoLength = header.readInt32LE(16);
  const sessionInfoOffset = header.readInt32LE(20);
  const variableCount = header.readInt32LE(24);
  const variableHeaderOffset = header.readInt32LE(28);
  const bufferCount = header.readInt32LE(32);
  const rowLength = header.readInt32LE(36);
  const sessionStartDateSeconds = Number(header.readBigInt64LE(112));
  const sessionStartTime = header.readDoubleLE(120);
  const sessionEndTime = header.readDoubleLE(128);
  const lapCount = header.readInt32LE(136);
  const recordCount = header.readInt32LE(140);

  if (
    version <= 0 ||
    tickRate <= 0 ||
    tickRate > 1000 ||
    bufferCount <= 0 ||
    bufferCount > 4 ||
    variableCount <= 0 ||
    variableCount > MAX_VARIABLES ||
    rowLength <= 0 ||
    rowLength > MAX_BUFFER_LENGTH ||
    sessionInfoLength <= 0 ||
    sessionInfoLength > MAX_SESSION_INFO_LENGTH ||
    lapCount < 0 ||
    recordCount < 0 ||
    !Number.isSafeInteger(sessionStartDateSeconds) ||
    !Number.isFinite(sessionStartTime) ||
    !Number.isFinite(sessionEndTime)
  ) {
    throw new Error("Invalid iRacing IBT header values");
  }

  const variableHeaderLength = variableCount * IRSDK_VAR_HEADER_SIZE;
  if (
    variableHeaderOffset < IRSDK_DISK_HEADER_SIZE ||
    !validFileRange(variableHeaderOffset, variableHeaderLength, fileSize) ||
    !validFileRange(sessionInfoOffset, sessionInfoLength, fileSize) ||
    variableHeaderOffset + variableHeaderLength > sessionInfoOffset
  ) {
    throw new Error("Invalid iRacing IBT metadata layout");
  }

  const dataOffset = sessionInfoOffset + sessionInfoLength;
  const telemetryLength = recordCount * rowLength;
  const expectedFileSize = dataOffset + telemetryLength;
  if (
    !Number.isSafeInteger(telemetryLength) ||
    !Number.isSafeInteger(expectedFileSize) ||
    expectedFileSize > fileSize
  ) {
    throw new Error(
      "Truncated iRacing IBT: " +
        `expected at least ${expectedFileSize} bytes, found ${fileSize}`,
    );
  }

  return {
    version,
    status,
    tickRate,
    sessionInfoLength,
    sessionInfoOffset,
    variableCount,
    variableHeaderOffset,
    bufferCount,
    rowLength,
    sessionStartDateSeconds,
    sessionStartTime,
    sessionEndTime,
    lapCount,
    recordCount,
    dataOffset,
    expectedFileSize,
  };
}

/**
 * Streaming reader for iRacing's on-disk binary telemetry format.
 *
 * The reader exposes the same snapshots as the live SDK reader, allowing an
 * IBT recording to reuse IRacingTelemetrySource and the normal parser ->
 * pipeline path. Only one telemetry row is held in memory.
 */
export class IRacingIbtReader {
  readonly path: string;

  private fd: number | null = null;
  private variableTable: IRacingVariableTable | null = null;
  private sessionInfo = "";
  private rowBuffer: Buffer | null = null;
  private nextRecord = 0;
  private _metadata: IRacingIbtMetadata | null = null;

  constructor(path: string) {
    this.path = resolve(path);
  }

  get metadata(): IRacingIbtMetadata | null {
    return this._metadata;
  }

  get recordsRead(): number {
    return this.nextRecord;
  }

  get done(): boolean {
    return (
      this._metadata !== null &&
      this.nextRecord >= this._metadata.recordCount
    );
  }

  start(): void {
    if (this.fd !== null) return;

    this._metadata = null;
    this.nextRecord = 0;
    const fd = openSync(this.path, "r");
    try {
      const fileSize = fstatSync(fd).size;
      const header = Buffer.allocUnsafe(IRSDK_DISK_HEADER_SIZE);
      readExactly(fd, header, 0);
      const layout = parseLayout(header, fileSize);

      const variableHeaders = Buffer.allocUnsafe(
        layout.variableCount * IRSDK_VAR_HEADER_SIZE,
      );
      readExactly(fd, variableHeaders, layout.variableHeaderOffset);
      const variableTable = new IRacingVariableTable(
        variableHeaders,
        layout.rowLength,
      );

      const sessionBytes = Buffer.allocUnsafe(layout.sessionInfoLength);
      readExactly(fd, sessionBytes, layout.sessionInfoOffset);
      const nullOffset = sessionBytes.indexOf(0);
      const sessionInfo = sessionBytes
        .subarray(
          0,
          nullOffset >= 0 ? nullOffset : sessionBytes.length,
        )
        .toString("utf8");
      if (!sessionInfo.trim()) {
        throw new Error("iRacing IBT session information is empty");
      }

      this.fd = fd;
      this.variableTable = variableTable;
      this.sessionInfo = sessionInfo;
      this.rowBuffer = Buffer.allocUnsafe(layout.rowLength);
      this.nextRecord = 0;
      this._metadata = {
        version: layout.version,
        status: layout.status,
        tickRate: layout.tickRate,
        sessionStartDate: new Date(
          layout.sessionStartDateSeconds * 1000,
        ),
        sessionStartTime: layout.sessionStartTime,
        sessionEndTime: layout.sessionEndTime,
        lapCount: layout.lapCount,
        recordCount: layout.recordCount,
        rowLength: layout.rowLength,
        dataOffset: layout.dataOffset,
        fileSize,
        trailingBytes: fileSize - layout.expectedFileSize,
        missingRaceIQVariables:
          IRACING_TELEMETRY_VARIABLES.filter(
            (name) => !variableTable.has(name),
          ),
      };
    } catch (error) {
      closeSync(fd);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
    this.variableTable = null;
    this.sessionInfo = "";
    this.rowBuffer = null;
  }

  readLatest(): IRacingSdkSnapshot | null {
    const metadata = this._metadata;
    if (
      this.fd === null ||
      !metadata ||
      !this.variableTable ||
      !this.rowBuffer ||
      this.done
    ) {
      return null;
    }

    const rowOffset =
      metadata.dataOffset + this.nextRecord * metadata.rowLength;
    readExactly(this.fd, this.rowBuffer, rowOffset);
    const values = this.variableTable.readAll(this.rowBuffer);
    const recordIndex = this.nextRecord;
    this.nextRecord++;

    const sessionTick = values.SessionTick;
    const tick =
      typeof sessionTick === "number" && Number.isFinite(sessionTick)
        ? Math.trunc(sessionTick)
        : recordIndex;

    return {
      tick,
      // Session YAML is immutable within an IBT recording.
      sessionInfoUpdate: 0,
      sessionInfo: this.sessionInfo,
      values,
    };
  }
}
