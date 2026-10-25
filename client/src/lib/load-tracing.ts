const enabled = import.meta.env.DEV;
const startedAt = performance.now();
let stage = "module evaluation";
let heartbeat: number | undefined;

function elapsed(): string {
  return `${(performance.now() - startedAt).toFixed(0)}ms`;
}

export function startClientLoadTrace(): void {
  if (!enabled) return;
  console.info(`[RaceIQ load] ${elapsed()} start`, location.pathname);
  heartbeat = window.setInterval(() => {
    console.warn(`[RaceIQ load] ${elapsed()} still waiting at: ${stage}`);
  }, 5000);

  if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (entry.duration >= 200) {
          console.warn(`[RaceIQ load] long task ${entry.duration.toFixed(0)}ms at ${entry.startTime.toFixed(0)}ms`);
        }
      }
    }).observe({ type: "longtask", buffered: true });
  }

  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
      const bytes = entry.transferSize;
      if (entry.duration >= 1000 || bytes >= 1_000_000) {
        console.warn(`[RaceIQ load] slow resource ${entry.duration.toFixed(0)}ms ${bytes ? `${(bytes / 1_000_000).toFixed(1)}MB ` : ""}${entry.name}`);
      }
    }
  }).observe({ type: "resource", buffered: true });
}

export function markClientLoadStage(nextStage: string, complete = false): void {
  if (!enabled) return;
  stage = nextStage;
  console.info(`[RaceIQ load] ${elapsed()} ${nextStage}`);
  if (complete && heartbeat !== undefined) {
    window.clearInterval(heartbeat);
    heartbeat = undefined;
  }
}
