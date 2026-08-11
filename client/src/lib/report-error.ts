/**
 * Ship browser-side errors to the server log file.
 *
 * The server's file logger only captures the Node/Bun console, so anything that
 * fails in the browser would otherwise live only in the user's devtools console
 * — invisible to us when they send a diagnostics export. Everything reported
 * here lands in `raceiq.log`, which the export zips as `logs.txt`.
 *
 * Best-effort throughout: reporting must never throw or block the UI.
 */
import { client } from "./rpc";

type ReportLevel = "warn" | "error";

interface PendingReport {
  level: ReportLevel;
  scope: string;
  message: string;
  detailJson?: string;
  repeatCount: number;
  flushAt: number;
}

const COALESCE_WINDOW_MS = 500;
const MAX_COALESCING_REPORTS = 32;
const MAX_REPORT_QUEUE = 32;
const MAX_IN_FLIGHT_REPORTS = 2;
const MAX_DETAIL_JSON_BYTES = 4 * 1024;
const DETAIL_PREVIEW_BYTES = 1024;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

const coalescingReports = new Map<string, PendingReport>();
const reportQueue: PendingReport[] = [];
let flushTimer: number | undefined;
let inFlightReports = 0;
let reportingInstalled = false;

// Captured before installClientErrorReporting patches the console. Reporter
// failures must never flow back through reportClientError and recurse.
const rawConsoleError = typeof console === "undefined" ? undefined : console.error.bind(console);
const rawConsoleWarn = typeof console === "undefined" ? undefined : console.warn.bind(console);

/**
 * Coalesce matching reports briefly, then send through a bounded queue. A noisy
 * render loop creates at most one report per fingerprint per window, while
 * distinct reports keep independent deadlines.
 */
export function reportClientError(scope: string, message: string, detail?: unknown, level: ReportLevel = "error"): void {
  try {
    const normalizedScope = scope.slice(0, 64);
    const normalizedMessage = message.slice(0, 4000);
    const fingerprint = `${level}\u0000${normalizedScope}\u0000${normalizedMessage}`;
    const existing = coalescingReports.get(fingerprint);
    if (existing) {
      existing.repeatCount++;
      return;
    }

    if (coalescingReports.size >= MAX_COALESCING_REPORTS) {
      const oldest = coalescingReports.entries().next().value as [string, PendingReport] | undefined;
      if (oldest) {
        coalescingReports.delete(oldest[0]);
        enqueueReport(oldest[1]);
      }
    }

    const now = Date.now();
    coalescingReports.set(fingerprint, {
      level,
      scope: normalizedScope,
      message: normalizedMessage,
      detailJson: serializeDetail(detail),
      repeatCount: 1,
      flushAt: now + COALESCE_WINDOW_MS,
    });
    scheduleFlush();
  } catch (error) {
    reportReporterFailure(error);
  }
}

function scheduleFlush(): void {
  if (flushTimer !== undefined || coalescingReports.size === 0) return;
  const first = coalescingReports.values().next().value as PendingReport | undefined;
  if (!first) return;
  flushTimer = window.setTimeout(flushDueReports, Math.max(0, first.flushAt - Date.now()));
}

function flushDueReports(): void {
  flushTimer = undefined;
  const now = Date.now();
  for (const [fingerprint, report] of coalescingReports) {
    if (report.flushAt > now) continue;
    coalescingReports.delete(fingerprint);
    enqueueReport(report);
  }
  pumpReportQueue();
  scheduleFlush();
}

function enqueueReport(report: PendingReport): void {
  if (reportQueue.length >= MAX_REPORT_QUEUE) reportQueue.shift();
  reportQueue.push(report);
  pumpReportQueue();
}

function pumpReportQueue(): void {
  while (inFlightReports < MAX_IN_FLIGHT_REPORTS && reportQueue.length > 0) {
    const report = reportQueue.shift();
    if (!report) return;
    inFlightReports++;
    sendReport(report)
      .catch(reportReporterFailure)
      .finally(() => {
        inFlightReports--;
        pumpReportQueue();
      });
  }
}

async function sendReport(report: PendingReport): Promise<void> {
  const repeatSuffix = report.repeatCount > 1 ? ` [repeated ${report.repeatCount} times]` : "";
  const detail = report.detailJson === undefined ? undefined : JSON.parse(report.detailJson);
  await client.api["client-log"].$post({
    json: {
      level: report.level,
      scope: report.scope,
      message: `${report.message.slice(0, 4000 - repeatSuffix.length)}${repeatSuffix}`,
      detail: report.repeatCount > 1 ? { repeatCount: report.repeatCount, detail } : detail,
    },
  });
}

function reportReporterFailure(error: unknown): void {
  try {
    rawConsoleError?.("[ClientErrorReporter] Failed to deliver client log", error);
  } catch {
    // Logging must never break the UI.
  }
}

/**
 * Patch `console.error`/`console.warn` to also ship to the server log. Call once
 * at app startup. Originals captured above remain the reporter's failure sink.
 */
export function installClientErrorReporting(): void {
  if (typeof window === "undefined" || reportingInstalled) return;
  reportingInstalled = true;

  console.error = (...args: unknown[]) => {
    rawConsoleError?.(...args);
    reportClientError("console", formatArgs(args), undefined, "error");
  };
  console.warn = (...args: unknown[]) => {
    rawConsoleWarn?.(...args);
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

/** Store a detached, byte-bounded JSON snapshot rather than retaining app data. */
function serializeDetail(detail: unknown): string | undefined {
  if (detail === undefined) return undefined;
  const normalized = detail instanceof Error ? { name: detail.name, message: detail.message, stack: detail.stack } : detail;
  let json: string;
  try {
    json = JSON.stringify(normalized) ?? JSON.stringify(String(normalized)) ?? '"[unserializable]"';
  } catch {
    json = JSON.stringify(String(normalized)) ?? '"[unserializable]"';
  }

  const encoded = utf8Encoder.encode(json);
  if (encoded.byteLength <= MAX_DETAIL_JSON_BYTES) return json;

  const preview = utf8Decoder.decode(encoded.subarray(0, DETAIL_PREVIEW_BYTES));
  const summary = JSON.stringify({
    truncated: true,
    originalBytes: encoded.byteLength,
    preview,
  });
  return utf8Encoder.encode(summary).byteLength <= MAX_DETAIL_JSON_BYTES ? summary : JSON.stringify({ truncated: true, originalBytes: encoded.byteLength });
}
