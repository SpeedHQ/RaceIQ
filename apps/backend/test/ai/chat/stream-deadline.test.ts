import { describe, expect, test } from "bun:test";
import { STREAM_STALL_LIMITS, withStallDeadline } from "@raceiq/backend-core/ai/agent-stream";
import { AiProviderError } from "@raceiq/backend-core/ai/provider-error";

/** A source that accepts the subscription and then never produces anything. */
function silentSource<T>(): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => new Promise<IteratorResult<T>>(() => {}),
    }),
  };
}

function stallOf(error: unknown): AiProviderError {
  expect(error).toBeInstanceOf(AiProviderError);
  return error as AiProviderError;
}

describe("withStallDeadline", () => {
  test("forwards every chunk untouched when the provider keeps streaming", async () => {
    async function* source() {
      yield { type: "start" };
      yield { type: "text-delta" };
      yield { type: "finish" };
    }

    const seen: string[] = [];
    for await (const chunk of withStallDeadline(source(), { firstChunkMs: 1_000, idleMs: 1_000 })) {
      seen.push(chunk.type);
    }
    expect(seen).toEqual(["start", "text-delta", "finish"]);
  });

  test("fails with a typed timeout when the provider never produces a first chunk", async () => {
    let error: unknown;
    try {
      for await (const _chunk of withStallDeadline(silentSource(), { firstChunkMs: 20, idleMs: 1_000 })) {
        // no chunks expected
      }
    } catch (caught) {
      error = caught;
    }

    expect(stallOf(error).code).toBe("timeout");
    expect(stallOf(error).message).toContain("did not respond");
  });

  test("fails after a mid-stream stall and keeps the chunks already delivered", async () => {
    async function* stallingSource() {
      yield { type: "text-delta" };
      await new Promise<never>(() => {});
    }

    const seen: string[] = [];
    let error: unknown;
    try {
      for await (const chunk of withStallDeadline(stallingSource(), { firstChunkMs: 1_000, idleMs: 20 })) {
        seen.push(chunk.type);
      }
    } catch (caught) {
      error = caught;
    }

    expect(seen).toEqual(["text-delta"]);
    expect(stallOf(error).code).toBe("timeout");
    expect(stallOf(error).message).toContain("stopped sending output");
  });

  test("default bounds are generous enough for a slow reasoning model", () => {
    expect(STREAM_STALL_LIMITS.firstChunkMs).toBeGreaterThanOrEqual(60_000);
    expect(STREAM_STALL_LIMITS.idleMs).toBeGreaterThanOrEqual(30_000);
  });
});
