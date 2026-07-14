/**
 * Ship browser-side errors to the server log file.
 *
 * The server's file logger only captures the Node/Bun console, so anything that
 * fails in the browser would otherwise live only in the user's devtools console
 * — invisible to us when they send a diagnostics export. Everything reported
 * here lands in `raceiq.log`, which the export zips as `logs.txt`.
 *
 * This is deliberately generic: one global install captures uncaught errors,
 * unhandled promise rejections, and every `console.error` / `console.warn` the
 * app makes, so no per-feature wiring is needed.
 *
 * Best-effort throughout: reporting must never throw or block the UI.
 */
import { client } from "./rpc";

/**
 * Report every error, unthrottled — nothing is dropped or de-duplicated, so
 * the log reflects exactly what the client saw, including repeat counts.
 */
export function reportClientError(scope: string, message: string, detail?: unknown, level: "warn" | "error" = "error"): void {
  try {
    void client.api["client-log"]
      .$post({
        json: {
          level,
          scope: scope.slice(0, 64),
          message: message.slice(0, 4000),
          detail: safeDetail(detail),
        },
      })
      .catch(() => {});
  } catch {
    /* logging must never break the UI */
  }
}

/**
 * Patch `console.error`/`console.warn` to also ship to the server log. Call
 * once at app startup.
 *
 * Patching the console (rather than only listening for uncaught errors) is what
 * makes this generic: errors the app already catches and handles never reach
 * `window.onerror`, but they almost always get consoled. Uncaught errors and
 * rejections are forwarded separately by `crash-diagnostics.ts`.
 */
export function installClientErrorReporting(): void {
  if (typeof window === "undefined") return;

  const origError = console.error.bind(console);
  const origWarn = console.warn.bind(console);
  console.error = (...args: unknown[]) => {
    origError(...args);
    reportClientError("console", formatArgs(args), undefined, "error");
  };
  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    reportClientError("console", formatArgs(args), undefined, "warn");
  };
}

function formatArgs(args: unknown[]): string {
  return args
    .map((a) => {
      if (typeof a === "string") return a;
      if (a instanceof Error) return a.stack ?? a.message;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");
}

/** Errors don't survive JSON.stringify; flatten to something loggable. */
function safeDetail(detail: unknown): unknown {
  if (detail === undefined) return undefined;
  if (detail instanceof Error) {
    return { name: detail.name, message: detail.message, stack: detail.stack };
  }
  try {
    JSON.stringify(detail);
    return detail;
  } catch {
    return String(detail);
  }
}
