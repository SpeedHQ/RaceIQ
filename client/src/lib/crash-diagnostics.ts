/**
 * Crash diagnostics — persists one bounded breadcrumb record for the current
 * document. A later load reports it only when the previous document never
 * reached a clean page lifecycle boundary.
 *
 * Captures:
 * - Unhandled errors and promise rejections via window events. These are also
 *   forwarded to the server log so they appear in the diagnostics export.
 * - Periodic Chromium heap samples and the latest Three.js GPU snapshot.
 */

import { installClientErrorReporting, reportClientError } from "./report-error";

const CURRENT_SESSION_KEY = "raceiq.crash.current_session";
const SESSION_RECORD_PREFIX = "raceiq.crash.session.";
const LEGACY_KEYS = ["raceiq.crash.last_error", "raceiq.crash.last_rejection", "raceiq.crash.last_heap", "raceiq.crash.last_gpu"] as const;
const RECORD_VERSION = 1;

/** Latest GPU snapshot, populated by CarWireframe when the 3D scene is mounted. */
interface GpuSnapshot {
  geometries: number;
  textures: number;
  programs: number;
  drawCalls: number;
  triangles: number;
  ts: number;
  url: string;
}
let lastGpuSnapshot: GpuSnapshot | null = null;

/**
 * Called from the 3D scene each second with Three.js renderer.info. The
 * most recent snapshot is included in the heap breadcrumb so a GPU-side
 * crash leaves visible evidence (runaway geometry/texture/program counts)
 * even though it won't show up in performance.memory.
 */
export function recordGpuSnapshot(info: { memory: { geometries: number; textures: number }; programs: { length: number } | null; render: { calls: number; triangles: number } }): void {
  lastGpuSnapshot = {
    geometries: info.memory.geometries,
    textures: info.memory.textures,
    programs: info.programs?.length ?? 0,
    drawCalls: info.render.calls,
    triangles: info.render.triangles,
    ts: Date.now(),
    url: location.href,
  };
}

// performance.memory is non-standard (Chromium only) and not in lib.dom.d.ts.
interface PerformanceMemory {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
}
interface PerformanceWithMemory extends Performance {
  memory?: PerformanceMemory;
}

interface HeapSnapshot {
  usedJSHeapSize: number;
  totalJSHeapSize: number;
  jsHeapSizeLimit: number;
  ts: number;
  url: string;
}

type LifecycleState = "active" | "clean" | "suspended";

interface CrashSessionRecord {
  version: typeof RECORD_VERSION;
  sessionId: string;
  state: LifecycleState;
  startedAt: number;
  endedAt?: number;
  url: string;
  lastError?: unknown;
  lastRejection?: unknown;
  lastHeap?: HeapSnapshot;
  lastGpu?: GpuSnapshot;
}

let currentSession: CrashSessionRecord | null = null;

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function sessionRecordKey(sessionId: string): string {
  return `${SESSION_RECORD_PREFIX}${sessionId}`;
}

function writeSession(record: CrashSessionRecord): void {
  try {
    localStorage.setItem(sessionRecordKey(record.sessionId), safeStringify(record));
  } catch {
    // Storage may be full or disabled. Diagnostics remain best effort.
  }
}

function readSession(sessionId: string): CrashSessionRecord | null {
  try {
    const raw = localStorage.getItem(sessionRecordKey(sessionId));
    if (!raw) return null;
    const record = JSON.parse(raw) as CrashSessionRecord;
    if (record.version !== RECORD_VERSION || record.sessionId !== sessionId) return null;
    if (record.state !== "active" && record.state !== "clean" && record.state !== "suspended") return null;
    return record;
  } catch {
    return null;
  }
}

function updateCurrentSession(update: Partial<CrashSessionRecord>): void {
  if (!currentSession) return;
  currentSession = { ...currentSession, ...update };
  writeSession(currentSession);
}

function clearLegacyBreadcrumbs(): void {
  try {
    for (const key of LEGACY_KEYS) localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

function reportUnexpectedPreviousSession(): void {
  try {
    const previousSessionId = sessionStorage.getItem(CURRENT_SESSION_KEY);
    const previous = previousSessionId ? readSession(previousSessionId) : null;
    if (previousSessionId) localStorage.removeItem(sessionRecordKey(previousSessionId));
    clearLegacyBreadcrumbs();

    if (previous?.state !== "active") return;

    console.group("[RaceIQ] Diagnostics from unexpectedly ended page session");
    console.warn("previous page session ended unexpectedly:", {
      startedAt: previous.startedAt,
      url: previous.url,
    });
    if (previous.lastError) console.warn("last error:", previous.lastError);
    if (previous.lastRejection) console.warn("last rejection:", previous.lastRejection);
    if (previous.lastHeap) console.warn("last heap sample before unexpected termination:", previous.lastHeap);
    if (previous.lastGpu) console.warn("last GPU sample before unexpected termination:", previous.lastGpu);
    console.groupEnd();
  } catch {
    clearLegacyBreadcrumbs();
  }
}

function beginSession(): void {
  const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  currentSession = {
    version: RECORD_VERSION,
    sessionId,
    state: "active",
    startedAt: Date.now(),
    url: location.href,
  };
  writeSession(currentSession);
  try {
    sessionStorage.setItem(CURRENT_SESSION_KEY, sessionId);
  } catch {
    // ignore
  }
}

function installLifecycleHandlers(): void {
  window.addEventListener("pagehide", (event) => {
    if (event.persisted) {
      updateCurrentSession({ state: "suspended", endedAt: Date.now(), url: location.href });
      return;
    }

    updateCurrentSession({ state: "clean", endedAt: Date.now(), url: location.href });
    if (!currentSession) return;
    try {
      localStorage.removeItem(sessionRecordKey(currentSession.sessionId));
    } catch {
      // ignore
    }
  });

  window.addEventListener("pageshow", (event) => {
    if (!event.persisted || !currentSession) return;
    updateCurrentSession({ state: "active", endedAt: undefined, url: location.href });
    try {
      sessionStorage.setItem(CURRENT_SESSION_KEY, currentSession.sessionId);
    } catch {
      // ignore
    }
  });
}

function installGlobalErrorHandlers(): void {
  window.addEventListener("error", (ev) => {
    const record = {
      message: ev.message,
      filename: ev.filename,
      lineno: ev.lineno,
      colno: ev.colno,
      stack: ev.error?.stack ?? null,
      ts: Date.now(),
      url: location.href,
    };
    updateCurrentSession({ lastError: record });
    reportClientError("window.onerror", ev.message || "Uncaught error", record);
  });

  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason as { message?: string; stack?: string } | string | undefined;
    const record = {
      reason: typeof reason === "string" ? reason : (reason?.message ?? String(reason)),
      stack: typeof reason === "object" && reason ? (reason.stack ?? null) : null,
      ts: Date.now(),
      url: location.href,
    };
    updateCurrentSession({ lastRejection: record });
    reportClientError("unhandledrejection", record.reason, record);
  });
}

function startHeapMonitor(): void {
  const perf = performance as PerformanceWithMemory;
  if (!perf.memory) return; // Firefox/Safari — no memory API, silently noop.

  const WARN_RATIO = 0.85;
  let warned = false;

  setInterval(() => {
    const mem = perf.memory;
    if (!mem) return;
    const { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit } = mem;
    const sample: HeapSnapshot = { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit, ts: Date.now(), url: location.href };
    updateCurrentSession(lastGpuSnapshot ? { lastHeap: sample, lastGpu: lastGpuSnapshot } : { lastHeap: sample });

    const ratio = usedJSHeapSize / jsHeapSizeLimit;
    if (ratio > WARN_RATIO && !warned) {
      warned = true;
      console.warn(
        `[RaceIQ] JS heap pressure: ${(ratio * 100).toFixed(1)}% (${(usedJSHeapSize / 1048576).toFixed(0)} MB / ${(jsHeapSizeLimit / 1048576).toFixed(0)} MB). An OOM crash (Aw Snap, error 5) may be imminent.`,
      );
    } else if (ratio < WARN_RATIO * 0.9) {
      warned = false; // re-arm if heap recovers
    }
  }, 5000);
}

export function installCrashDiagnostics(): void {
  // Patch console first so unexpected-session breadcrumbs reach the server log.
  installClientErrorReporting();
  reportUnexpectedPreviousSession();
  beginSession();
  installGlobalErrorHandlers();
  installLifecycleHandlers();
  startHeapMonitor();
}
