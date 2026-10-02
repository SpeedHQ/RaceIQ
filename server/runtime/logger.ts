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

const PINO_LEVEL_NAMES: Record<number, string> = {
  10: "trace",
  20: "debug",
  30: "info",
  40: "warn",
  50: "error",
  60: "fatal",
};

function singleLine(value: unknown): string {
  return String(value ?? "").replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

export function formatDiagnosticRecord(record: Record<string, unknown>): string {
  const { time, level, service, msg, ...context } = record;
  const parsedTime = typeof time === "number" ? new Date(time) : new Date(typeof time === "string" ? time : Date.now());
  const timestamp = Number.isNaN(parsedTime.getTime()) ? new Date().toISOString() : parsedTime.toISOString();
  const severity = (typeof level === "number" ? PINO_LEVEL_NAMES[level] : String(level ?? "info")).toUpperCase();
  const source = singleLine(service || "raceiq");
  const message = singleLine(msg);
  const details = Object.keys(context).length > 0 ? `\t${JSON.stringify(context)}` : "";
  return `${timestamp} ${severity.padEnd(5)} [${source}] ${message}${details}\n`;
}

export function formatDiagnosticLogLine(line: string): string {
  const newline = line.endsWith("\n") ? "\n" : "";
  const raw = newline ? line.slice(0, -1) : line;
  try {
    const record = JSON.parse(raw) as unknown;
    if (record === null || typeof record !== "object" || Array.isArray(record)) return line;
    const formatted = formatDiagnosticRecord(record as Record<string, unknown>);
    return newline ? formatted : formatted.slice(0, -1);
  } catch {
    return line;
  }
}

const VALID_LOG_LEVELS = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const requestedLogLevel = process.env.RACEIQ_LOG_LEVEL ?? "info";
const logLevel = VALID_LOG_LEVELS.has(requestedLogLevel) ? requestedLogLevel : "info";
const diagnosticStream = {
  write(line: string): void {
    diagnosticLogStore.write(formatDiagnosticLogLine(line));
  },
};
const stdoutStream = {
  write(line: string): void {
    process.stdout.write(formatDiagnosticLogLine(line));
  },
};

export const logger = pino(
  {
    level: logLevel,
    base: { service: "raceiq" },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level(label) {
        return { level: label };
      },
    },
  },
  pino.multistream([
    { level: "trace", stream: diagnosticStream },
    { level: "trace", stream: stdoutStream },
  ]),
);
export const log = logger;
if (requestedLogLevel !== logLevel) {
  logger.warn({ requestedLogLevel, fallbackLogLevel: logLevel }, "Invalid RACEIQ_LOG_LEVEL; using fallback");
}

export function readRecentLogText(): string {
  return diagnosticLogStore.readRetainedText().split("\n").map((line) => formatDiagnosticLogLine(line)).join("\n");
}

export function errorLogger(): MiddlewareHandler {
  return async (c, next) => {
    try { await next(); } catch (err) { log.error({ err }, `${c.req.method} ${c.req.path}`); throw err; }
  };
}

function writeConsole(level: "debug" | "info" | "warn" | "error", args: unknown[]): void {
  log[level](args.map(formatArg).join(" "));
}

export function captureConsole(): void {
  console.info = (...args: unknown[]) => writeConsole("info", args);
  console.debug = (...args: unknown[]) => writeConsole("debug", args);
  console.log = (...args: unknown[]) => writeConsole("info", args);
  console.warn = (...args: unknown[]) => writeConsole("warn", args);
  console.error = (...args: unknown[]) => writeConsole("error", args);
}
