// test/chat-generations.test.ts
//
// Unit tests for the chat-generation helpers in server/ai/chat-agent.ts:
// parseThreadGeneration, generationThreadId, listThreadGenerations, and
// resolveActiveThread. The latter two are bound to the module's
// `getChatMemory()` singleton, so this file mocks just that one export
// (spreading through every other real export unchanged) to exercise them
// against a fake in-memory thread store.
import { describe, test, expect, mock } from "bun:test";
import * as RealChatAgent from "../server/ai/chat-agent";

function makeFakeMemory(existingThreadIds: string[]) {
  const threads = new Set(existingThreadIds);
  return {
    threads,
    getThreadById: async ({ threadId }: { threadId: string }) =>
      threads.has(threadId) ? { id: threadId } : null,
  };
}

const fakeMemory = makeFakeMemory(["lap-42", "lap-42~g2"]);

mock.module("../server/ai/chat-agent", () => ({
  ...RealChatAgent,
  getChatMemory: () => fakeMemory,
}));

const {
  parseThreadGeneration,
  generationThreadId,
  listThreadGenerations,
  resolveActiveThread,
} = await import("../server/ai/chat-agent");

describe("parseThreadGeneration", () => {
  test("bare base id is generation 1", () => {
    expect(parseThreadGeneration("lap-42")).toEqual({ base: "lap-42", gen: 1 });
  });

  test("~g2 suffix parses to gen 2", () => {
    expect(parseThreadGeneration("lap-42~g2")).toEqual({ base: "lap-42", gen: 2 });
  });

  test("~g separator, not a dash — compare ids parse to base with gen 1", () => {
    // A dash would break compare's `slice(8).split("-")` id parsing elsewhere
    // in the app, which is exactly why `~g` was chosen as the separator.
    expect(parseThreadGeneration("compare-3-7")).toEqual({ base: "compare-3-7", gen: 1 });
    expect(parseThreadGeneration("compare-3-7~g4")).toEqual({ base: "compare-3-7", gen: 4 });
  });

  test("malformed suffix (non-integer, or < 2) falls back to gen 1 on the whole id", () => {
    expect(parseThreadGeneration("lap-42~gX")).toEqual({ base: "lap-42~gX", gen: 1 });
    expect(parseThreadGeneration("lap-42~g1")).toEqual({ base: "lap-42~g1", gen: 1 });
  });
});

describe("generationThreadId", () => {
  test("gen 1 is the bare base (round-trips with parseThreadGeneration)", () => {
    expect(generationThreadId("lap-42", 1)).toBe("lap-42");
    expect(parseThreadGeneration(generationThreadId("lap-42", 1))).toEqual({ base: "lap-42", gen: 1 });
  });

  test("gen > 1 suffixes with ~g<N> (round-trips with parseThreadGeneration)", () => {
    expect(generationThreadId("lap-42", 3)).toBe("lap-42~g3");
    expect(parseThreadGeneration(generationThreadId("lap-42", 3))).toEqual({ base: "lap-42", gen: 3 });
  });

  test("round-trips for a compare base too", () => {
    const id = generationThreadId("compare-3-7", 5);
    expect(id).toBe("compare-3-7~g5");
    expect(parseThreadGeneration(id)).toEqual({ base: "compare-3-7", gen: 5 });
  });
});

describe("listThreadGenerations (against a fake memory)", () => {
  test("lists existing generations oldest→newest, stopping at the first gap", async () => {
    const gens = await listThreadGenerations("lap-42");
    expect(gens).toEqual([
      { threadId: "lap-42", generation: 1 },
      { threadId: "lap-42~g2", generation: 2 },
    ]);
  });

  test("empty when the base has never been chatted", async () => {
    const gens = await listThreadGenerations("lap-999");
    expect(gens).toEqual([]);
  });
});

describe("resolveActiveThread (against a fake memory)", () => {
  test("returns the newest existing generation", async () => {
    expect(await resolveActiveThread("lap-42")).toBe("lap-42~g2");
  });

  test("falls back to the base when nothing exists yet", async () => {
    expect(await resolveActiveThread("lap-999")).toBe("lap-999");
  });
});
