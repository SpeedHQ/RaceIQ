// test/chat-generations.test.ts
//
// Unit tests for the chat-generation helpers in server/ai/chat-agent.ts:
// parseThreadGeneration, generationThreadId, listThreadGenerations, and
// resolveActiveThread. The latter two probe a memory store, which they take as
// an optional second argument, so this file just passes a fake in-memory thread
// store — no module mocking involved.
//
// Do NOT reach for `mock.module` here. It is PROCESS-global in Bun and cannot
// be undone, so a stubbed `getChatMemory()` leaks into every later test file in
// the run. A previous version gated the stub on a `stubActive` flag that fell
// back to the REAL `getChatMemory()` after this file's afterAll — which meant
// the module-scope `memory: getChatMemory()` calls in mastra/agents/*.ts
// (lap-chat, compare-chat, setup-engineer) ran through the stub and stood up
// the real LibSQL-backed Mastra memory, whose open handles hung the test
// process forever whenever this file ran before another file that loads those
// agents (e.g. laps-issues-route.test.ts).
import { describe, test, expect } from "bun:test";
import {
  parseThreadGeneration,
  generationThreadId,
  listThreadGenerations,
  resolveActiveThread,
  chatMemoryOptions,
  chatThreadId,
  compareChatThreadId,
  parseCompareChatThreadId,
} from "../../../server/ai/chat-agent";

function makeFakeMemory(existingThreadIds: string[]) {
  const threads = new Set(existingThreadIds);
  return {
    threads,
    getThreadById: async ({ threadId }: { threadId: string }) => (threads.has(threadId) ? { id: threadId } : null),
  };
}

const fakeMemory = makeFakeMemory(["lap-42", "lap-42~g2"]);

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
    const gens = await listThreadGenerations("lap-42", fakeMemory);
    expect(gens).toEqual([
      { threadId: "lap-42", generation: 1 },
      { threadId: "lap-42~g2", generation: 2 },
    ]);
  });

  test("empty when the base has never been chatted", async () => {
    const gens = await listThreadGenerations("lap-999", fakeMemory);
    expect(gens).toEqual([]);
  });
});

describe("resolveActiveThread (against a fake memory)", () => {
  test("returns the newest existing generation", async () => {
    expect(await resolveActiveThread("lap-42", fakeMemory)).toBe("lap-42~g2");
  });

  test("falls back to the base when nothing exists yet", async () => {
    expect(await resolveActiveThread("lap-999", fakeMemory)).toBe("lap-999");
  });
});

describe("chatMemoryOptions", () => {
  test("binds agent stream memory to requested thread and resource", () => {
    expect(chatMemoryOptions("compare-5-6")).toEqual({
      memory: { thread: "compare-5-6", resource: "raceiq" },
    });
  });
});

describe("chatThreadId", () => {
  test("isolates lap chat by hashed quality identity and preserves generation parsing", () => {
    const identity = "policy-1:quality-generation-1";
    const original = chatThreadId(5, identity);
    expect(chatThreadId(5, identity)).toBe(original);
    expect(chatThreadId(5, "policy-1:quality-generation-2")).not.toBe(original);
    expect(original).toMatch(/^lap-5~q[0-9a-f]{64}$/);
    expect(original).not.toContain(identity);
    expect(parseThreadGeneration(generationThreadId(original, 3))).toEqual({ base: original, gen: 3 });
  });
});
describe("compareChatThreadId", () => {
  test("isolates chat history by quality identity while preserving canonical lap order", () => {
    const original = compareChatThreadId(5, 6, "policy-1:quality-generation-1");
    expect(compareChatThreadId(6, 5, "policy-1:quality-generation-1")).toBe(original);
    expect(compareChatThreadId(5, 6, "policy-1:quality-generation-2")).not.toBe(original);
    expect(parseCompareChatThreadId(generationThreadId(original, 2))).toEqual([5, 6]);
    expect(original).toMatch(/^compare-5-6~q[0-9a-f]{64}$/);
    expect(original).not.toContain("policy-1:quality-generation-1");
    expect(parseThreadGeneration(generationThreadId(original, 2))).toEqual({ base: original, gen: 2 });
  });
});
