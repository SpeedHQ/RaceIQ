import {
  appendFileSync,
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { resolveDataDir } from "./data-dir";
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

function format(level: string, args: unknown[]): string {
  const msg = args.map(formatArg).join(" ");
  return `${new Date().toISOString()} [${level}] ${msg}\n`;
}

function write(line: string) {
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

export const log = {
  info(...args: unknown[]) {
    const line = format("INFO", args);
    write(line);
    try { process.stdout.write(line); } catch {}
  },
  warn(...args: unknown[]) {
    const line = format("WARN", args);
    write(line);
    try { process.stderr.write(line); } catch {}
  },
  error(...args: unknown[]) {
    const line = format("ERROR", args);
    write(line);
    try { process.stderr.write(line); } catch {}
  },
};

/** Hono middleware that catches and logs unhandled route errors. */
export function errorLogger(): MiddlewareHandler {
  return async (c, next) => {
    try {
      await next();
    } catch (err) {
      log.error(`${c.req.method} ${c.req.path}`, err);
      throw err;
    }
  };
}

/**
 * Redirect console.log/warn/error to the file logger.
 * Call once at startup so third-party code also gets captured.
 */
export function captureConsole() {
  console.log = (...args: unknown[]) => log.info(...args);
  console.warn = (...args: unknown[]) => log.warn(...args);
  console.error = (...args: unknown[]) => log.error(...args);
}
