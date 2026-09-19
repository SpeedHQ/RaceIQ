import { Worker } from "node:worker_threads";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import type { TuneIssue } from "../../shared/racing/tuning/issues";
import { IS_COMPILED } from "../runtime/config/paths";

interface PendingAnalysis {
  packets: TelemetryPacket[];
  resolve: (issues: TuneIssue[]) => void;
  reject: (error: Error) => void;
}

// Bound concurrent tool requests so completed-lap telemetry cannot grow without limit.
const MAX_PENDING_LAPS = 4;
const pending: PendingAnalysis[] = [];
let worker: Worker | null = null;
let active: PendingAnalysis | null = null;
let scheduled = false;

function failWorker(current: Worker, error: Error): void {
  if (worker !== current) return;
  worker = null;
  active?.reject(error);
  active = null;
  for (const job of pending.splice(0)) job.reject(error);
  void current.terminate();
}

function getWorker(): Worker {
  if (worker) return worker;
  // Bun resolves embedded entrypoint names directly; file URLs fail on compiled Windows builds.
  const current = new Worker(IS_COMPILED ? "./server/experiments/lap-issues-worker.ts" : new URL("./lap-issues-worker.ts", import.meta.url));
  worker = current;
  current.on("message", (result: { issues: TuneIssue[]; error?: undefined } | { error: string }) => {
    if (worker !== current || !active) return;
    const job = active;
    active = null;
    if (result.error !== undefined) job.reject(new Error(result.error));
    else job.resolve(result.issues);
    if (pending.length === 0) current.unref();
    else scheduleNext();
  });
  current.on("error", (error) => failWorker(current, error instanceof Error ? error : new Error(String(error))));
  current.on("exit", (code) => failWorker(current, new Error(`Lap analysis worker exited (${code})`)));
  return current;
}

function scheduleNext(): void {
  if (scheduled || active || pending.length === 0) return;
  scheduled = true;
  // Yield before structured-cloning a completed lap for the worker.
  setImmediate(() => {
    scheduled = false;
    if (active || pending.length === 0) return;
    const job = pending.shift()!;
    try {
      const current = getWorker();
      active = job;
      current.ref();
      current.postMessage(job.packets);
      // Worker now owns its copy; do not retain a second full lap here.
      job.packets = [];
    } catch (error) {
      active = null;
      job.reject(error instanceof Error ? error : new Error(String(error)));
      if (pending.length === 0) worker?.unref();
      else scheduleNext();
    }
  });
}

/** Packets belong to a completed lap and must not be mutated after submission. */
export function analyzeLapIssues(packets: TelemetryPacket[]): Promise<TuneIssue[]> {
  if (pending.length + Number(active !== null) >= MAX_PENDING_LAPS) {
    return Promise.reject(new Error("Lap analysis backlog is full"));
  }
  const { promise, resolve, reject } = Promise.withResolvers<TuneIssue[]>();
  pending.push({ packets, resolve, reject });
  scheduleNext();
  return promise;
}
