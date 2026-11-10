/**
 * Stall deadline for long-lived AI streams.
 *
 * A provider stream that opens and then goes quiet leaves the chat panel with a
 * spinner and no error, which reads as "the app hung". The UI-message stream
 * keeps its chunks one-for-one; this wrapper only turns silence into a typed
 * error so the caller's existing catch can surface it.
 *
 * Two bounds, both generous enough for a slow reasoning model:
 * - `firstChunkMs` covers connect + upstream queue + first token.
 * - `idleMs` covers a gap between chunks once output has started (a model that
 *   is thinking streams nothing, so this is the only progress signal we have).
 */
import { AiProviderError } from "./provider-error";

export const STREAM_STALL_LIMITS = {
  firstChunkMs: 90_000,
  idleMs: 60_000,
} as const;

function stallError(ms: number, received: boolean): AiProviderError {
  const seconds = Math.max(1, Math.round(ms / 1_000));
  return new AiProviderError(
    received
      ? `The AI provider stopped sending output for ${seconds}s.`
      : `The AI provider did not respond within ${seconds}s.`,
    { code: "timeout", isRetryable: true },
  );
}

/**
 * Forward every chunk of `source` unchanged, failing with a typed timeout
 * error when a chunk takes longer than the applicable bound.
 */
export async function* withStallDeadline<T>(
  source: AsyncIterable<T>,
  limits: { firstChunkMs: number; idleMs: number } = STREAM_STALL_LIMITS,
): AsyncGenerator<T, void, undefined> {
  const iterator = source[Symbol.asyncIterator]();
  let received = false;
  try {
    for (;;) {
      const bound = received ? limits.idleMs : limits.firstChunkMs;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(stallError(bound, received)), Math.max(0, bound));
      });
      const next = iterator.next();
      // When the deadline wins this race the pending read may still reject
      // later; that rejection has no consumer, so keep it quiet.
      next.catch(() => {});
      try {
        const result = await Promise.race([next, timeout]);
        if (result.done) return;
        received = true;
        yield result.value;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  } finally {
    // Never await: the abandoned read can stay pending forever, and awaiting
    // its `return()` would hang the very stream this wrapper is protecting.
    Promise.resolve(iterator.return?.()).catch(() => {});
  }
}
