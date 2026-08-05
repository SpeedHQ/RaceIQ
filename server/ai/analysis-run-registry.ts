export type AnalysisRunStatus = "active" | "finished" | "failed";

export interface AnalysisRun {
  key: string;
  status: AnalysisRunStatus;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

const runs = new Map<string, AnalysisRun>();
const EVICT_MS = 60_000;

export function getAnalysisRun(key: string): AnalysisRun | undefined {
  return runs.get(key);
}

export function beginAnalysisRun(key: string): AnalysisRun | undefined {
  const existing = runs.get(key);
  if (existing?.status === "active") return undefined;
  const run: AnalysisRun = { key, status: "active", startedAt: Date.now() };
  runs.set(key, run);
  return run;
}

export function finishAnalysisRun(key: string, error?: unknown): void {
  const run = runs.get(key);
  if (run?.status !== "active") return;
  run.status = error == null ? "finished" : "failed";
  run.finishedAt = Date.now();
  if (error != null) run.error = error instanceof Error ? error.message : String(error);
  setTimeout(() => {
    if (runs.get(key) === run) runs.delete(key);
  }, EVICT_MS);
}
