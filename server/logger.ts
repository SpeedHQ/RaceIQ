import { appendFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { resolveDataDir } from "./data-dir";
import type { MiddlewareHandler } from "hono";

const logDir = resolveDataDir();
mkdirSync(logDir, { recursive: true });
const logFile = join(logDir, "raceiq.log");

// Truncate on startup
writeFileSync(logFile, `=== RaceIQ started ${new Date().toISOString()} ===\n`);

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? a.message;
  return JSON.stringify(a);
}

function format(level: string, args: unknown[]): string {
  const msg = args.map(formatArg).join(" ");
  return `${new Date().toISOString()} [${level}] ${msg}\n`;
}

function write(line: string) {
  try {
    appendFileSync(logFile, line);
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
