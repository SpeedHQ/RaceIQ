import type { UIMessageChunk } from "ai";

/**
 * In-memory registry of detached agent-turn "runs", keyed by chat threadId.
 *
 * A run starts when a chat POST kicks off an agent stream and keeps
 * executing independently of any client connection — the client can
 * unmount/refresh/reconnect at any point and re-attach to the same run via
 * `/api/chats/:threadId/run/stream`, which replays every chunk produced so
 * far and then live-tails the rest. Persistence (reasoning/messages) happens
 * inside the run itself (see agent-stream.ts's onFinish), never tied to a
 * subscriber being present.
 *
 * Registry is process-local and lost on server restart — acceptable per the
 * plan (no Redis / no cross-process durability requirement). Finished runs
 * are kept around briefly so a client reconnecting right as the turn
 * finishes still sees the tail of the stream, then evicted.
 */

export type ChatRunStatus = "active" | "finished";

export interface ChatRun {
  runId: string;
  threadId: string;
  status: ChatRunStatus;
  startedAt: number;
  finishedAt?: number;
  /** Every UI-message chunk produced so far, in order — the replay buffer. */
  chunks: UIMessageChunk[];
  /** Live subscribers notified as new chunks land. */
  subscribers: Set<() => void>;
  /** Notified once, when the run transitions to `finished`. */
  finishListeners: Set<() => void>;
  /** Abort the underlying agent call (wired to the model call's abortSignal). */
  abortController: AbortController;
}

const runs = new Map<string, ChatRun>();

/** How long a finished run's buffer is kept around for a late reconnect. */
const EVICT_MS = 60_000;

/** Look up a run (active or recently finished) for a thread, if any. */
export function getRun(threadId: string): ChatRun | undefined {
  return runs.get(threadId);
}

/** Look up only an active run for a thread. */
export function getActiveRun(threadId: string): ChatRun | undefined {
  const run = runs.get(threadId);
  return run?.status === "active" ? run : undefined;
}

/**
 * Reserve a run slot for a turn about to start. If a run is already active
 * for this thread, returns it unchanged (`isNew: false`) — the double-start
 * guard: callers must NOT kick off a second agent stream in that case, just
 * attach to the existing run's replay+tail stream.
 */
export function reserveChatRun(threadId: string): { run: ChatRun; isNew: boolean } {
  const existing = runs.get(threadId);
  if (existing && existing.status === "active") {
    return { run: existing, isNew: false };
  }
  const run: ChatRun = {
    runId: crypto.randomUUID(),
    threadId,
    status: "active",
    startedAt: Date.now(),
    chunks: [],
    subscribers: new Set(),
    finishListeners: new Set(),
    abortController: new AbortController(),
  };
  runs.set(threadId, run);
  return { run, isNew: true };
}

/** Append a chunk to a run's replay buffer and notify live subscribers. */
export function pushChunk(run: ChatRun, chunk: UIMessageChunk): void {
  if (run.status === "finished") return;
  run.chunks.push(chunk);
  for (const notify of run.subscribers) {
    try {
      notify();
    } catch (err) {
      console.error("[chat-run-registry] subscriber notify failed:", err);
    }
  }
}

/** Mark a run finished, notify finish listeners once, and schedule eviction. */
export function finishRun(run: ChatRun): void {
  if (run.status === "finished") return;
  run.status = "finished";
  run.finishedAt = Date.now();
  for (const notify of run.finishListeners) {
    try {
      notify();
    } catch (err) {
      console.error("[chat-run-registry] finish listener failed:", err);
    }
  }
  run.finishListeners.clear();
  setTimeout(() => {
    if (runs.get(run.threadId) === run) runs.delete(run.threadId);
  }, EVICT_MS);
}

/**
 * Build a replay-then-live-tail stream of a run's chunks: an SSE consumer
 * gets everything buffered so far immediately, then anything produced after
 * as it happens, and the stream closes once the run finishes. Used both by
 * the initial POST response and every subsequent reconnect — identical code
 * path, so a reconnect is indistinguishable from the original connection.
 */
export function buildReplayStream(run: ChatRun): ReadableStream<UIMessageChunk> {
  let idx = 0;
  let unsubscribe: (() => void) | undefined;

  return new ReadableStream<UIMessageChunk>({
    start(controller) {
      let flushChain: Promise<void> = Promise.resolve();
      let closed = false;

      const flush = (): Promise<void> => {
        flushChain = flushChain.then(async () => {
          if (closed) return;
          while (idx < run.chunks.length) {
            controller.enqueue(run.chunks[idx]);
            idx++;
          }
        });
        return flushChain;
      };

      const close = () => {
        flushChain = flushChain.then(() => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      };

      const onChunk = () => {
        flush().catch((err) => console.error("[chat-run-registry] flush failed:", err));
      };
      const onFinish = () => {
        close();
      };

      run.subscribers.add(onChunk);
      if (run.status === "finished") {
        onFinish();
      } else {
        run.finishListeners.add(onFinish);
      }
      unsubscribe = () => {
        run.subscribers.delete(onChunk);
        run.finishListeners.delete(onFinish);
      };

      // Replay whatever's already buffered; if the run had already finished
      // by the time we got here, `close` (chained after `flush`) still runs
      // in order since both push onto `flushChain`.
      flush().catch((err) => console.error("[chat-run-registry] initial flush failed:", err));
    },
    cancel() {
      unsubscribe?.();
    },
  });
}
