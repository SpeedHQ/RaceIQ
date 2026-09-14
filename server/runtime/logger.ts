import pino from "pino";
import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveDataDir } from "./config/data-dir";
import type { MiddlewareHandler } from "hono";

const logDir = resolveDataDir();
mkdirSync(logDir, { recursive: true });

const LOG_FILE_PATH = join(logDir, "raceiq.log");
const MAX_LOG_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTICS_LOG_BYTES = 64 * 1024;
const MAX_LOG_LINE_BYTES = 16 * 1024;
const LOG_COMPACTION_RETAIN_BYTES = MAX_LOG_FILE_BYTES / 2;
const startupMarker = `=== RaceIQ started ${new Date().toISOString()} ===\n`;
const startupMarkerBuffer = Buffer.from(startupMarker);

let logSizeBytes = 0;
try {
  writeFileSync(LOG_FILE_PATH, startupMarkerBuffer);
  logSizeBytes = startupMarkerBuffer.byteLength;
} catch {}

interface FileTail {
  data: Buffer;
  truncated: boolean;
}

function readFileTail(filePath: string, maxBytes: number): FileTail {
  if (maxBytes <= 0) return { data: Buffer.alloc(0), truncated: false };
  try {
    const fd = openSync(filePath, "r");
    try {
      const fileSize = fstatSync(fd).size;
      const bytesToRead = Math.min(fileSize, maxBytes);
      const data = Buffer.alloc(bytesToRead);
      const bytesRead = readSync(fd, data, 0, bytesToRead, fileSize - bytesToRead);
      return {
        data: data.subarray(0, bytesRead),
        truncated: fileSize > bytesRead,
      };
    } finally {
      closeSync(fd);
    }
  } catch {
    return { data: Buffer.alloc(0), truncated: false };
  }
}

function completeLineTail(tail: FileTail): Buffer {
  if (!tail.truncated) {
    return tail.data.subarray(
      tail.data.subarray(0, startupMarkerBuffer.byteLength).equals(startupMarkerBuffer)
        ? startupMarkerBuffer.byteLength
        : 0,
    );
  }
  const firstNewline = tail.data.indexOf(0x0a);
  return firstNewline === -1
    ? Buffer.alloc(0)
    : tail.data.subarray(firstNewline + 1);
}

/**
 * Read only the most recent bounded byte range while retaining the startup
 * marker that identifies this run. Never allocates based on the full file size.
 */
export function readRecentLogText(maxBytes = MAX_DIAGNOSTICS_LOG_BYTES): string {
  const boundedBytes = Math.max(0, Math.min(maxBytes, MAX_LOG_FILE_BYTES));
  if (boundedBytes === 0) return "";
  if (boundedBytes <= startupMarkerBuffer.byteLength) {
    return startupMarkerBuffer.subarray(0, boundedBytes).toString("utf8");
  }

  const tail = completeLineTail(
    readFileTail(LOG_FILE_PATH, boundedBytes - startupMarkerBuffer.byteLength),
  );
  return Buffer.concat([startupMarkerBuffer, tail]).toString("utf8");
}

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function truncateLine(line: string): Buffer {
  const lineBuffer = Buffer.from(line);
  if (lineBuffer.byteLength <= MAX_LOG_LINE_BYTES) return lineBuffer;

  let truncated = lineBuffer.subarray(0, MAX_LOG_LINE_BYTES - 1).toString("utf8");
  while (Buffer.byteLength(truncated) > MAX_LOG_LINE_BYTES - 1) {
    truncated = truncated.slice(0, -1);
  }
  return Buffer.from(`${truncated}\n`);
}

function writeBounded(line: string): void {
  try {
    const lineBuffer = truncateLine(line);
    if (logSizeBytes + lineBuffer.byteLength <= MAX_LOG_FILE_BYTES) {
      appendFileSync(LOG_FILE_PATH, lineBuffer);
      logSizeBytes += lineBuffer.byteLength;
      return;
    }
    const recentBudget = Math.max(
      0,
      LOG_COMPACTION_RETAIN_BYTES - startupMarkerBuffer.byteLength - lineBuffer.byteLength,
    );
    const recent = completeLineTail(readFileTail(LOG_FILE_PATH, recentBudget));
    const retainedLog = Buffer.concat([startupMarkerBuffer, recent, lineBuffer]);
    writeFileSync(LOG_FILE_PATH, retainedLog);
    logSizeBytes = retainedLog.byteLength;
  } catch {}
}

const VALID_LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const requestedLogLevel = process.env.RACEIQ_LOG_LEVEL ?? "info";
const logLevel = VALID_LOG_LEVELS.has(requestedLogLevel) ? requestedLogLevel : "info";
const boundedFileStream = {
  write(line: string): void {
    writeBounded(line);
  },
};

export const logger = pino(
  {
    level: logLevel,
    base: { service: "raceiq" },
  },
  pino.multistream([
    { level: "trace", stream: boundedFileStream },
    { level: "trace", stream: process.stdout },
  ]),
);

export const log = logger;

if (requestedLogLevel !== logLevel) {
  logger.warn(
    { requestedLogLevel, fallbackLogLevel: logLevel },
    "Invalid RACEIQ_LOG_LEVEL; using fallback",
  );
}

/** Hono middleware that catches and logs unhandled route errors. */
export function errorLogger(): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next();
    } catch (err) {
      log.error({ err }, `${c.req.method} ${c.req.path}`);
      throw err;
    }
  };
}

/**
 * Redirect console.log/warn/error to the file logger.
 * Call once at startup so third-party code also gets captured.
 */
function writeConsole(level: "debug" | "info" | "warn" | "error", args: unknown[]): void {
  log[level](args.map(formatArg).join(" "));
}

export function captureConsole(): void {
  console.debug = (...args: unknown[]) => writeConsole("debug", args);
  console.log = (...args: unknown[]) => writeConsole("info", args);
  console.warn = (...args: unknown[]) => writeConsole("warn", args);
  console.error = (...args: unknown[]) => writeConsole("error", args);
}
