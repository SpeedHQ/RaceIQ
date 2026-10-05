import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  RecorderMessageDecoder,
  RecorderOpcode,
  encodeControlMessage,
  RECORDER_PROTOCOL_VERSION,
} from "@raceiq/backend-core/runtime/recorder-protocol";
import type {
  RecorderEngine,
  RecorderEvent,
  RecorderHealthSnapshot,
  RecorderOperation,
  RecorderShutdownReason,
} from "@raceiq/backend-core/runtime/recorder-engine";

type ClientOptions = { executablePath?: string; onUnhealthy?: (reason: string) => void | Promise<void> };
type PendingRequest = { operation: RecorderOperation; finalizationRead: boolean; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> | null };
const CONTROL_TIMEOUT_MS = 10_000;
const JOB_OPERATIONS: RecorderOperation[] = ["preview", "import", "reprocess", "encode-capture", "encode-lap-slices", "read-capture", "read-lap-window"];
const EVENT_BACKLOG_LIMIT = 4 * 1024 * 1024;
const DISPLAY_BACKLOG_LIMIT = 8 * 1024 * 1024;

function beforeDeadline<T>(work: Promise<T>, deadline: number, operation: string): Promise<T> {
  return new Promise<T>((resolveWork, rejectWork) => {
    const timer = setTimeout(() => rejectWork(new Error(`Recorder ${operation} exceeded shutdown deadline`)), Math.max(0, deadline - performance.now()));
    work.then(resolveWork, rejectWork).finally(() => clearTimeout(timer));
  });
}

export function resolveRecorderExecutablePath(): string {
  const executableName = process.platform === "win32" ? "raceiq-recorder.exe" : "raceiq-recorder";
  const currentModulePath = fileURLToPath(import.meta.url);
  const runningFromSource = currentModulePath.includes("/src/runtime/");
  const candidate = runningFromSource
    ? resolve(dirname(currentModulePath), "../../../../native/recorder/target/debug", executableName)
    : resolve(dirname(process.execPath), executableName);
  if (!existsSync(candidate)) throw new Error(`Bundled recorder executable not found at ${candidate}${runningFromSource ? "; run bun run build:recorder" : "; installation is incomplete"}`);
  return candidate;
}

export class RecorderClient implements RecorderEngine {
  #child: ChildProcessWithoutNullStreams | null = null;
  #decoder = new RecorderMessageDecoder();
  #pending = new Map<number, PendingRequest>();
  #subscribers = new Set<(event: RecorderEvent) => void | Promise<void>>();
  #eventQueue: RecorderEvent[] = [];
  #eventBytes = 0;
  #displayBytes = 0;
  #eventDraining = false;
  #eventDrainWaiters: Array<() => void> = [];
  #nextRequestId = 1;
  #health: RecorderHealthSnapshot = { state: "starting", pid: null, lastSuccessfulProbeAgeMs: null, reason: null, sources: [], logger: { state: "ready", error: null, droppedMessages: 0 } };
  #lastProbe = 0;
  #probeInFlight = false;
  #healthTimer: ReturnType<typeof setInterval> | null = null;
  #quiesced = false;
  #closed = false;
  #exited = false;
  #shutdownPromise: Promise<void> | null = null;
  #helloPromise: Promise<Record<string, unknown>> | null = null;
  #resolveHello: ((value: Record<string, unknown>) => void) | null = null;
  #rejectHello: ((error: Error) => void) | null = null;
  #intentionalStopping = false;
  #unhealthyNotified = false;
  #exitPromise: Promise<boolean> | null = null;
  #resolveExit: ((exited: boolean) => void) | null = null;
  #options: ClientOptions;

  constructor(options: ClientOptions = {}) { this.#options = options; }

  get health(): RecorderHealthSnapshot {
    return { ...this.#health, sources: [...this.#health.sources], lastSuccessfulProbeAgeMs: this.#lastProbe ? performance.now() - this.#lastProbe : null };
  }

  get exited(): boolean { return this.#exited; }

  subscribe(handler: (event: RecorderEvent) => void | Promise<void>): () => void {
    this.#subscribers.add(handler);
    return () => { this.#subscribers.delete(handler); };
  }

  async start(config: Record<string, unknown>): Promise<void> {
    if (this.#child) throw new Error("Recorder client already started");
    const executablePath = this.#options.executablePath ?? resolveRecorderExecutablePath();
    if (!isAbsolute(executablePath)) throw new Error("Recorder executablePath must be an absolute bundled executable path");
    const dataDir = config.dataDir;
    if (typeof dataDir !== "string" || !isAbsolute(dataDir)) throw new Error("Recorder configuration requires absolute dataDir");
    const helloWaiter = Promise.withResolvers<Record<string, unknown>>();
    this.#helloPromise = helloWaiter.promise;
    this.#resolveHello = helloWaiter.resolve;
    this.#rejectHello = helloWaiter.reject;
    const exitWaiter = Promise.withResolvers<boolean>();
    this.#exitPromise = exitWaiter.promise;
    this.#resolveExit = exitWaiter.resolve;
    const child = spawn(executablePath, [], {
      cwd: dirname(executablePath),
      env: { ...process.env, RACEIQ_RECORDER_LOG_DIR: resolve(dataDir) },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;
    child.stdout.on("data", (chunk: Buffer) => this.#consume(chunk));
    child.stdout.on("end", () => {
      try { this.#decoder.finish(); }
      catch (error) {
        void this.#fail("failed", error instanceof Error ? error.message : String(error));
      }
      // Child "exit" can precede delivery of bytes already buffered by its
      // stdout pipe. Drain those bytes before deciding an ACK was lost.
      this.#rejectPending("Recorder process exited");
    });
    child.stderr.on("data", (chunk: Buffer) => process.stderr.write(chunk));
    child.on("error", (error) => {
      if (child.pid === undefined) { this.#exited = true; this.#closed = true; this.#resolveExit?.(true); }
      this.#rejectHello?.(error);
      void this.#fail("offline", `Recorder process error: ${error.message}`);
    });
    child.on("exit", (code, signal) => {
      this.#resolveExit?.(true);
      this.#closed = true;
      this.#exited = true;
      if (!this.#intentionalStopping) {
        const reason = `Recorder exited (${signal ?? code ?? "unknown"})`;
        this.#rejectHello?.(new Error(reason));
        void this.#fail("offline", reason);
      }
    });
    try {
      const hello = await Promise.race([
        this.#helloPromise,
        new Promise<Record<string, unknown>>((_, reject) => setTimeout(() => reject(new Error("Recorder HELLO timed out")), CONTROL_TIMEOUT_MS)),
      ]);
      if (hello.protocolVersion !== RECORDER_PROTOCOL_VERSION || typeof hello.pid !== "number" || !Number.isInteger(hello.pid) || hello.pid <= 0) throw new Error("Recorder HELLO protocol or PID mismatch");
      this.#health = { ...this.#health, pid: hello.pid, state: "starting" };
      await this.request("configure", config);
      this.#healthTimer = setInterval(() => { void this.#probeHealth(); }, 2_000);
      await this.#probeHealth();
    } catch (error) {
      await this.#fail("failed", `Recorder startup failed: ${String(error)}`);
      this.#intentionalStopping = true;
      child.kill();
      await Promise.race([this.#exitPromise, new Promise<void>((resolveExit) => setTimeout(resolveExit, 2_000))]);
      throw error;
    }
  }

  request<T = unknown>(operation: RecorderOperation, input: Record<string, unknown>): Promise<T> {
    return this.#request(operation, input, false);
  }

  #request<T>(operation: RecorderOperation, input: Record<string, unknown>, finalizationRead: boolean): Promise<T> {
    if (!this.#child || this.#closed) return Promise.reject(new Error("Recorder is not running"));
    if (this.#intentionalStopping && JOB_OPERATIONS.includes(operation) && !finalizationRead) return Promise.reject(new Error("Recorder is stopping; job cancelled"));
    if (this.#quiesced && !["read-capture", "read-lap-window", "health", "shutdown"].includes(operation)) return Promise.reject(new Error("Recorder is finalizing"));
    const requestId = this.#allocateRequestId();
    const payload = encodeControlMessage(RecorderOpcode.Request, requestId, { operation, input });
    const { promise, resolve: resolveRequest, reject: rejectRequest } = Promise.withResolvers<T>();
    const timer = JOB_OPERATIONS.includes(operation) ? null : setTimeout(() => {
      this.#pending.delete(requestId);
      rejectRequest(new Error(`Recorder ${operation} request timed out`));
    }, CONTROL_TIMEOUT_MS);
    this.#pending.set(requestId, { operation, finalizationRead, resolve: resolveRequest as (value: unknown) => void, reject: rejectRequest, timer });
    this.#child.stdin.write(payload, (error) => {
      if (!error) return;
      if (timer) clearTimeout(timer);
      this.#pending.delete(requestId);
      rejectRequest(error);
      void this.#fail("offline", `Recorder pipe failed: ${error.message}`);
    });
    return promise;
  }

  requestFinalizationRead<T = unknown>(operation: "read-capture" | "read-lap-window", input: Record<string, unknown>): Promise<T> {
    return this.#request(operation, input, true);
  }


  shutdown(reason: RecorderShutdownReason): Promise<void> {
    if (this.#shutdownPromise) return this.#shutdownPromise;
    this.#intentionalStopping = true;
    this.#health = { ...this.#health, state: "stopping", reason };
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    this.#healthTimer = null;
    for (const [id, pending] of this.#pending) {
      if (JOB_OPERATIONS.includes(pending.operation) && !pending.finalizationRead) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new Error("Recorder is stopping; job cancelled"));
        this.#pending.delete(id);
      }
    }
    const child = this.#child;
    if (!child) return Promise.resolve();
    this.#shutdownPromise = (async () => {
      const deadline = performance.now() + CONTROL_TIMEOUT_MS;
      let requestFailure: unknown = null;
      try {
        await beforeDeadline(this.request("shutdown", { reason, phase: "finalize" }), deadline, "finalization");
        this.#quiesced = true;
        await beforeDeadline(this.#waitForEventDrain(), deadline, "event drain");
      } catch (error) {
        requestFailure = error;
      }
      try { await beforeDeadline(this.request("shutdown", { reason, phase: "exit" }), deadline, "exit request"); } catch (error) { requestFailure ??= error; }
      child.stdin.end();
      const remaining = Math.max(0, deadline - performance.now());
      let exited = await Promise.race([
        this.#exitPromise!,
        new Promise<boolean>((resolveExit) => setTimeout(() => resolveExit(false), remaining)),
      ]);
      if (!exited) {
        if (process.platform === "win32" && child.pid !== undefined) {
          const cleanup = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          const closed = new Promise<void>((resolveCleanup, rejectCleanup) => {
            cleanup.once("error", rejectCleanup);
            cleanup.once("close", (code) => code === 0 ? resolveCleanup() : rejectCleanup(new Error(`Owned recorder tree cleanup exited ${code}`)));
          });
          try { await beforeDeadline(closed, performance.now() + 1_000, "owned tree cleanup"); }
          catch (error) { requestFailure ??= error; cleanup.kill(); child.kill("SIGKILL"); }
        } else {
          child.kill("SIGTERM");
        }
        exited = await Promise.race([this.#exitPromise!, new Promise<boolean>((resolveExit) => setTimeout(() => resolveExit(false), 1_000))]);
      }
      if (!exited) {
        child.kill("SIGKILL");
        exited = await Promise.race([this.#exitPromise!, new Promise<boolean>((resolveExit) => setTimeout(() => resolveExit(false), 1_000))]);
      }
      if (!exited) throw new Error("Recorder could not be terminated; shutdown incomplete");
      this.#closed = true;
      await beforeDeadline(this.#waitForEventDrain(), deadline, "final event drain");
      if (requestFailure) throw new Error(`Recorder shutdown request failed: ${String(requestFailure)}`);
    })();
    return this.#shutdownPromise;
  }

  #allocateRequestId(): number {
    if (this.#nextRequestId > 0xffff_ffff) throw new Error("Recorder request ID space exhausted");
    return this.#nextRequestId++;
  }

  #consume(chunk: Uint8Array): void {
    try {
      for (const message of this.#decoder.push(chunk)) {
        if (message.opcode === RecorderOpcode.Hello) {
          const hello = JSON.parse(new TextDecoder().decode(message.payload)) as Record<string, unknown>;
          this.#resolveHello?.(hello);
        } else if (message.opcode === RecorderOpcode.Response) {
          const pending = this.#pending.get(message.requestId);
          if (!pending) throw new Error(`Unexpected recorder response ID ${message.requestId}`);
          this.#pending.delete(message.requestId);
          if (pending.timer) clearTimeout(pending.timer);
          const response = JSON.parse(new TextDecoder().decode(message.payload));
          if (response.ok) pending.resolve(response.result);
          else pending.reject(new Error(response.error?.message ?? "Recorder request failed"));
        } else if (message.opcode === RecorderOpcode.LiveFrame) {
          if (message.payload.length < 16) throw new Error("Truncated recorder LIVE_FRAME");
          const view = new DataView(message.payload.buffer, message.payload.byteOffset, 16);
          this.#queueEvent({ type: "live-frame", sequence: view.getBigUint64(0, true), hostFrameTimeMs: view.getBigUint64(8, true), payload: message.payload.slice(16) });
        } else if (message.opcode === RecorderOpcode.Event || message.opcode === RecorderOpcode.Progress || message.opcode === RecorderOpcode.Status || message.opcode === RecorderOpcode.Fatal) {
          const data = JSON.parse(new TextDecoder().decode(message.payload));
          if (message.opcode === RecorderOpcode.Event) this.#queueEvent({ type: "event", eventSequence: BigInt(data.eventSequence), captureId: data.captureId, kind: data.kind, data: data.data });
          else if (message.opcode === RecorderOpcode.Progress) this.#queueEvent({ type: "progress", requestId: message.requestId, data });
          else if (message.opcode === RecorderOpcode.Status) {
            this.#applyStatus(data);
            this.#queueEvent({ type: "status", data });
          } else void this.#fail("failed", data.message ?? "Recorder reported fatal error");
        } else throw new Error(`Unexpected recorder opcode ${message.opcode}`);
      }
    } catch (error) { void this.#fail("failed", error instanceof Error ? error.message : String(error)); }
  }

  #applyStatus(data: Record<string, unknown>): void {
    if (typeof data.state === "string") {
      const logger = data.logger && typeof data.logger === "object" ? data.logger as RecorderHealthSnapshot["logger"] : this.#health.logger;
      this.#health = { ...this.#health, state: data.state as RecorderHealthSnapshot["state"], sources: Array.isArray(data.sources) ? data.sources : [], logger };
    }
  }

  #queueEvent(event: RecorderEvent): void {
    const isDisplay = event.type === "live-frame";
    const size = isDisplay ? event.payload.byteLength : Buffer.byteLength(JSON.stringify(event, (_key, value) => typeof value === "bigint" ? value.toString() : value));
    if (isDisplay) {
      while (this.#displayBytes + size > DISPLAY_BACKLOG_LIMIT) {
        const index = this.#eventQueue.findIndex((queued) => queued.type === "live-frame");
        if (index < 0) {
          if (size > DISPLAY_BACKLOG_LIMIT) return;
          break;
        }
        const [dropped] = this.#eventQueue.splice(index, 1);
        if (dropped?.type === "live-frame") this.#displayBytes -= dropped.payload.byteLength;
      }
      this.#displayBytes += size;
    } else {
      if (this.#eventBytes + size > EVENT_BACKLOG_LIMIT) {
        void this.#fail("failed", "Recorder reliable event delivery backlog exceeded 4 MiB");
        return;
      }
      this.#eventBytes += size;
    }
    this.#eventQueue.push(event);
    void this.#drainEvents();
  }

  async #drainEvents(): Promise<void> {
    if (this.#eventDraining) return;
    this.#eventDraining = true;
    try {
      while (this.#eventQueue.length) {
        const next = this.#eventQueue.shift()!;
        const display = next.type === "live-frame";
        const size = display ? next.payload.byteLength : Buffer.byteLength(JSON.stringify(next, (_key, value) => typeof value === "bigint" ? value.toString() : value));
        if (display) this.#displayBytes -= size;
        else this.#eventBytes -= size;
        for (const handler of this.#subscribers) await handler(next);
      }
    } catch (error) {
      await this.#fail("failed", `Recorder event handler failed: ${String(error)}`);
    } finally {
      this.#eventDraining = false;
      if (this.#eventQueue.length) void this.#drainEvents();
      else {
        const waiters = this.#eventDrainWaiters;
        this.#eventDrainWaiters = [];
        for (const resolve of waiters) resolve();
      }
    }
  }

  #waitForEventDrain(): Promise<void> {
    if (!this.#eventDraining && this.#eventQueue.length === 0) return Promise.resolve();
    const { promise, resolve } = Promise.withResolvers<void>();
    this.#eventDrainWaiters.push(resolve);
    return promise;
  }

  async #probeHealth(): Promise<void> {
    if (this.#closed || this.#probeInFlight) return;
    this.#probeInFlight = true;
    try {
      const status = await this.request<Record<string, unknown>>("health", {});
      this.#lastProbe = performance.now();
      this.#unhealthyNotified = false;
      this.#applyStatus(status);
    } catch (error) {
      const reason = String(error);
      this.#health = { ...this.#health, state: "unresponsive", reason };
      if (!this.#unhealthyNotified) {
        this.#unhealthyNotified = true;
        this.#notifyUnhealthy(reason);
      }
    } finally {
      this.#probeInFlight = false;
    }
  }

  async #fail(state: RecorderHealthSnapshot["state"], reason: string): Promise<void> {
    this.#health = { ...this.#health, state, reason };
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    this.#healthTimer = null;
    this.#rejectPending(reason);
    if (!this.#unhealthyNotified) {
      this.#unhealthyNotified = true;
      this.#notifyUnhealthy(reason);
    }

  }
  #rejectPending(reason: string): void {
    for (const pending of this.#pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }
  #notifyUnhealthy(reason: string): void {
    void Promise.resolve().then(() => this.#options.onUnhealthy?.(reason)).catch((error) => {
      process.stderr.write(`Recorder unhealthy callback failed: ${String(error)}\n`);
    });
  }
}
