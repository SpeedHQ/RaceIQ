/**
 * Crash diagnostics — leaves breadcrumbs in localStorage so the next page
 * load can surface what happened before an "Aw Snap" crash.
 *
 * Captures:
 * - Unhandled errors and promise rejections via window events.
 * - Periodic heap-pressure samples (Chrome-only performance.memory). If
 *   the JS heap climbs past 85% of its limit we log a warning AND write
 *   the last heap sample to localStorage — so if the tab dies moments
 *   later, the next load has a "this is what the heap looked like before
 *   you died" record to compare against.
 */

const LAST_ERROR_KEY = "raceiq.crash.last_error";
const LAST_REJECTION_KEY = "raceiq.crash.last_rejection";
const LAST_HEAP_KEY = "raceiq.crash.last_heap";
const LAST_GPU_KEY = "raceiq.crash.last_gpu";
const LOAD_COUNT_KEY = "raceiq.crash.load_count";

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
export function recordGpuSnapshot(
  info: { memory: { geometries: number; textures: number }; programs: { length: number } | null; render: { calls: number; triangles: number } },
): void {
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

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, safeStringify(value));
  } catch {
    // localStorage may be full or disabled — nothing we can do here.
  }
}

function reportPreviousCrash(): void {
  try {
    const err = localStorage.getItem(LAST_ERROR_KEY);
    const rej = localStorage.getItem(LAST_REJECTION_KEY);
    const heap = localStorage.getItem(LAST_HEAP_KEY);
    const gpu = localStorage.getItem(LAST_GPU_KEY);
    if (err || rej || heap || gpu) {
      console.group("%c[RaceIQ] Crash diagnostics from previous session", "color:#f59e0b;font-weight:bold");
      if (err) console.warn("last error:", JSON.parse(err));
      if (rej) console.warn("last rejection:", JSON.parse(rej));
      if (heap) console.warn("last heap sample (before tab died):", JSON.parse(heap));
      if (gpu) console.warn("last GPU sample (before tab died):", JSON.parse(gpu));
      console.groupEnd();
    }
    // Clear so each new load starts fresh — we only want *the most recent*
    // crash to surface, not stale data from weeks ago.
    localStorage.removeItem(LAST_ERROR_KEY);
    localStorage.removeItem(LAST_REJECTION_KEY);
    localStorage.removeItem(LAST_HEAP_KEY);
    localStorage.removeItem(LAST_GPU_KEY);
  } catch {
    // ignore
  }
}

function installGlobalErrorHandlers(): void {
  window.addEventListener("error", (ev) => {
    persist(LAST_ERROR_KEY, {
      message: ev.message,
      filename: ev.filename,
      lineno: ev.lineno,
      colno: ev.colno,
      stack: ev.error?.stack ?? null,
      ts: Date.now(),
      url: location.href,
    });
  });

  window.addEventListener("unhandledrejection", (ev) => {
    const reason = ev.reason as { message?: string; stack?: string } | string | undefined;
    persist(LAST_REJECTION_KEY, {
      reason: typeof reason === "string" ? reason : reason?.message ?? String(reason),
      stack: typeof reason === "object" && reason ? reason.stack ?? null : null,
      ts: Date.now(),
      url: location.href,
    });
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
    const sample = { usedJSHeapSize, totalJSHeapSize, jsHeapSizeLimit, ts: Date.now(), url: location.href };
    // Always persist the most recent sample so a crash leaves a useful
    // "last known heap state" breadcrumb regardless of where in the curve
    // we died.
    persist(LAST_HEAP_KEY, sample);
    // Also persist the most recent GPU snapshot if the 3D scene is mounted.
    if (lastGpuSnapshot) persist(LAST_GPU_KEY, lastGpuSnapshot);

    const ratio = usedJSHeapSize / jsHeapSizeLimit;
    if (ratio > WARN_RATIO && !warned) {
      warned = true;
      console.warn(
        `[RaceIQ] JS heap pressure: ${(ratio * 100).toFixed(1)}% ` +
        `(${(usedJSHeapSize / 1048576).toFixed(0)} MB / ${(jsHeapSizeLimit / 1048576).toFixed(0)} MB). ` +
        `An OOM crash (Aw Snap, error 5) may be imminent.`
      );
    } else if (ratio < WARN_RATIO * 0.9) {
      warned = false; // re-arm if heap recovers
    }
  }, 5000);
}

export function installCrashDiagnostics(): void {
  reportPreviousCrash();
  installGlobalErrorHandlers();
  startHeapMonitor();

  // Track load count so we can tell "crash loop vs one-off" at a glance.
  try {
    const n = Number(localStorage.getItem(LOAD_COUNT_KEY) ?? "0") + 1;
    localStorage.setItem(LOAD_COUNT_KEY, String(n));
  } catch {
    // ignore
  }
}
