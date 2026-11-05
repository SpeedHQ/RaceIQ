import { CodexRuntimeError, discoverCodex, runCodexGeneration, type CodexDiscovery, type CodexGenerationInput, type CodexGenerationResult } from "./runtime";

/** Owns every CLI operation, including preflight; shutdown closes admission first. */
export class CodexSupervisor {
  readonly #runs = new Map<AbortController, Promise<unknown>>();
  #closing = false;
  #stopped: Promise<void> | undefined;

  run(input: CodexGenerationInput): Promise<CodexGenerationResult> {
    return this.#own((signal) => runCodexGeneration({ ...input, signal }), input.signal);
  }

  discover(command: readonly string[], signal?: AbortSignal): Promise<CodexDiscovery> {
    return this.#own((ownedSignal) => discoverCodex(command, ownedSignal), signal);
  }

  #own<T>(run: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#closing) return Promise.reject(new CodexRuntimeError("cancelled", "RaceIQ is shutting down; Codex generation was not started."));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const operation = (async () => {
      try {
        const result = await run(controller.signal);
        // Do not publish/cache a completion that raced with application shutdown.
        if (controller.signal.aborted) throw new CodexRuntimeError("cancelled", "Codex analysis was cancelled.");
        return result;
      } finally {
        signal?.removeEventListener("abort", abort);
        this.#runs.delete(controller);
      }
    })();
    this.#runs.set(controller, operation);
    return operation;
  }

  stop(): Promise<void> {
    if (this.#stopped) return this.#stopped;
    this.#closing = true;
    const pending = [...this.#runs.values()];
    for (const controller of this.#runs.keys()) controller.abort();
    this.#stopped = Promise.allSettled(pending).then((results) => {
      // Expected generation/cancellation failures have already awaited owned-child
      // cleanup. A transport/finalizer failure must not become a successful quit.
      const failures = results.flatMap((result) => (result.status === "rejected" && !(result.reason instanceof CodexRuntimeError) ? [result.reason] : []));
      if (failures.length) throw new AggregateError(failures, "Codex resources did not close cleanly.");
    });
    return this.#stopped;
  }
}

export const codexSupervisor = new CodexSupervisor();
