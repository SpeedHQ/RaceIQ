import { Schema } from "effect";
import { SplitRequestSchema, WorkerMessageSchema, type SplitRequest, type WorkerMessage } from "./protocol";
import { SplitFailure } from "./index";
import type { PublishedManifest } from "./contract";

const isCompiled = import.meta.url.includes("/$bunfs/") || import.meta.url.includes("~BUN");
export function runSplitWorker(request: SplitRequest, onProgress?: (message: Extract<WorkerMessage, { type: "progress" }>) => void, signal?: AbortSignal): Promise<PublishedManifest> {
  const validated = Schema.decodeSync(SplitRequestSchema)(request);
  return new Promise((resolve, reject) => {
    let lastSequence = -1;
    const worker = isCompiled
      ? new Worker("./packages/capture-splitting/src/worker.ts")
      : new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      worker.terminate();
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      signal?.removeEventListener("abort", abort);
    };
    const fail = (error: SplitFailure) => { cleanup(); reject(error); };
    const abort = () => fail(new SplitFailure("IO", "Split worker interrupted"));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    worker.onmessageerror = () => fail(new SplitFailure("PROTOCOL", "Worker sent an unreadable response"));
    worker.onmessage = (event: MessageEvent<unknown>) => {
      let message: WorkerMessage;
      try { message = Schema.decodeUnknownSync(WorkerMessageSchema)(event.data); }
      catch (error) { fail(new SplitFailure("PROTOCOL", `Invalid worker response: ${String(error)}`)); return; }
      if (message.jobId !== validated.jobId || message.attemptId !== validated.attemptId) { fail(new SplitFailure("PROTOCOL", "Worker response identity mismatch")); return; }
      if (message.sequence <= lastSequence) { fail(new SplitFailure("PROTOCOL", "Worker response sequence is not monotonic")); return; }
      lastSequence = message.sequence;
      if (message.type === "progress") {
        try { onProgress?.(message); }
        catch (error) { fail(new SplitFailure("GAME", `Progress callback failed: ${String(error)}`)); }
        return;
      }
      cleanup();
      if (message.type === "failure") {
        const codes = ["IO", "FORMAT", "VERIFY", "GAME", "SOURCE_REVISION", "PROTOCOL", "UNKNOWN"] as const;
        const code = codes.includes(message.code as typeof codes[number]) ? message.code as typeof codes[number] : "UNKNOWN";
        reject(new SplitFailure(code, message.message));
      } else resolve(message.manifest);
    };
    worker.onerror = (event) => fail(new SplitFailure("IO", event.message));
    try { worker.postMessage(validated); }
    catch (error) { fail(new SplitFailure("IO", `Unable to start split worker: ${String(error)}`)); }
  });
}
