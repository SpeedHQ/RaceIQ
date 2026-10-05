import { AsyncLocalStorage } from "node:async_hooks";

const recordingJobContext = new AsyncLocalStorage<boolean>();
export type RecorderShutdownReason =
  | "signal"
  | "update"
  | "parent-eof"
  | "health-failure"
  | "startup-failure"
  | "engine-switch";

export type RecorderOperation =
  | "configure"
  | "health"
  | "preview"
  | "import"
  | "reprocess"
  | "encode-capture"
  | "encode-lap-slices"
  | "forget-session"
  | "debug-demand"
  | "read-capture"
  | "read-lap-window"
  | "shutdown";

export type RecorderHealthSnapshot = {
  state: "starting" | "ready" | "degraded" | "unresponsive" | "offline" | "failed" | "stopping";
  pid: number | null;
  lastSuccessfulProbeAgeMs: number | null;
  reason: string | null;
  sources: unknown[];
  logger: { state: "ready" | "degraded"; error: string | null; droppedMessages: number };
};

export type RecordingRuntimeShutdownHandler = (reason: RecorderShutdownReason) => Promise<void>;

export type RecorderEvent =
  | { type: "live-frame"; sequence: bigint; hostFrameTimeMs: bigint; payload: Uint8Array }
  | { type: "event"; eventSequence: bigint; captureId: string; kind: string; data: unknown }
  | { type: "status"; data: unknown }
  | { type: "progress"; requestId: number; data: unknown };

export interface RecorderEngine {
  readonly health: RecorderHealthSnapshot;
  start(config: Record<string, unknown>): Promise<void>;
  request<T = unknown>(operation: RecorderOperation, input: Record<string, unknown>): Promise<T>;
  requestFinalizationRead<T = unknown>(operation: "read-capture" | "read-lap-window", input: Record<string, unknown>): Promise<T>;
  subscribe(handler: (event: RecorderEvent) => void | Promise<void>): () => void;
  shutdown(reason: RecorderShutdownReason): Promise<void>;
}

let engineKind: "bun" | "rust" = "bun";
let recorderEngine: RecorderEngine | null = null;
let jobsPaused = false;
let activeJobs = 0;
let idleWaiters: Array<() => void> = [];
let runtimeShutdownHandler: RecordingRuntimeShutdownHandler | null = null;

export function getRecordingEngineKind(): "bun" | "rust" {
  return engineKind;
}

export function setRecordingEngineKind(kind: "bun" | "rust"): void {
  engineKind = kind;
}

export function registerRecorderEngine(engine: RecorderEngine | null): void {
  recorderEngine = engine;
}

export function getRecorderEngine(): RecorderEngine | null {
  return recorderEngine;
}


export function registerRecordingRuntimeShutdown(handler: RecordingRuntimeShutdownHandler | null): () => void {
  runtimeShutdownHandler = handler;
  return () => {
    if (runtimeShutdownHandler === handler) runtimeShutdownHandler = null;
  };
}

export async function shutdownRecordingRuntime(reason: RecorderShutdownReason): Promise<void> {
  if (runtimeShutdownHandler) await runtimeShutdownHandler(reason);
  else if (recorderEngine) await recorderEngine.shutdown(reason);
}
export async function runRecordingJob<T>(work: () => Promise<T>): Promise<T> {
  if (recordingJobContext.getStore()) return work();
  if (jobsPaused) throw new Error("Recording engine is switching; new jobs are unavailable");
  activeJobs++;
  try {
    return await recordingJobContext.run(true, work);
  } finally {
    activeJobs--;
    if (activeJobs === 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }
}

export async function pauseRecordingJobs(options: { drain?: boolean } = {}): Promise<void> {
  jobsPaused = true;
  if (options.drain === false || activeJobs === 0) return;
  await new Promise<void>((resolve) => idleWaiters.push(resolve));
}

export function resumeRecordingJobs(): void {
  jobsPaused = false;
}
