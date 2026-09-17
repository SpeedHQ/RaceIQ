import pino from "pino";
import { mkdirSync } from "node:fs";
import { resolveDataDir } from "./config/data-dir";
import { createDiagnosticLogStore } from "./diagnostic-log-store";
import type { MiddlewareHandler } from "hono";

const logDir = resolveDataDir();
mkdirSync(logDir, { recursive: true });
const diagnosticLogStore = createDiagnosticLogStore({ directory: logDir });
diagnosticLogStore.startRun();

function formatArg(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  try { return JSON.stringify(value); } catch { return String(value); }
}

const VALID_LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const requestedLogLevel = process.env.RACEIQ_LOG_LEVEL ?? "info";
const logLevel = VALID_LOG_LEVELS.has(requestedLogLevel) ? requestedLogLevel : "info";
const diagnosticStream = {
  write(line: string): void {
    diagnosticLogStore.write(line);
  },
};

export const logger = pino(
  { level: logLevel, base: { service: "raceiq" } },
  pino.multistream([
    { level: "trace", stream: diagnosticStream },
    { level: "trace", stream: process.stdout },
  ]),
);

export const log = logger;

if (requestedLogLevel !== logLevel) {
  logger.warn({ requestedLogLevel, fallbackLogLevel: logLevel }, "Invalid RACEIQ_LOG_LEVEL; using fallback");
}

export function readRecentLogText(): string {
  return diagnosticLogStore.readRetainedText();
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

function writeConsole(level: "debug" | "info" | "warn" | "error", args: unknown[]): void {
  log[level](args.map(formatArg).join(" "));
}

export function captureConsole(): void {
  console.debug = (...args: unknown[]) => writeConsole("debug", args);
  console.log = (...args: unknown[]) => writeConsole("info", args);
  console.warn = (...args: unknown[]) => writeConsole("warn", args);
  console.error = (...args: unknown[]) => writeConsole("error", args);
}
