// test/compact-thread.test.ts
import { describe, test, expect } from "bun:test";
import { forkThreadWithSummary, NothingToCompactError, MIN_COMPACT_MESSAGES } from "../server/ai/compact-thread";

// Minimal fake Mastra memory: enough surface for forkThreadWithSummary.
// Tracks threads by id (so getThreadById/createThread behave like a real
// store) plus every createThread call's metadata for assertions.
function makeFakeMemory(count: number) {
  const msgs = Array.from({ length: count }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 === 0 ? "user" : "assistant",
    content: { format: 2, parts: [{ type: "text", text: `turn ${i}` }], content: `turn ${i}` },
    createdAt: new Date(1000 + i),
    threadId: "t1",
    resourceId: "raceiq",
    type: "text",
  }));
  const threads = new Map<string, { id: string; metadata?: Record<string, unknown> }>();
  threads.set("t1", { id: "t1" });
  const deleted: string[] = [];
  const saved: any[] = [];
  const createThreadCalls: any[] = [];
  return {
    deleted,
    saved,
    threads,
    createThreadCalls,
    recall: async () => ({ messages: msgs }),
    getThreadById: async ({ threadId }: { threadId: string }) => threads.get(threadId) ?? null,
    createThread: async (opts: { threadId: string; resourceId: string; metadata?: Record<string, unknown> }) => {
      createThreadCalls.push(opts);
      const t = { id: opts.threadId, metadata: opts.metadata };
      threads.set(opts.threadId, t);
      return t;
    },
    saveMessages: async ({ messages }: any) => { saved.push(...messages); return { messages }; },
    deleteMessages: async (ids: string[]) => { deleted.push(...ids); },
  };
}

describe("forkThreadWithSummary", () => {
  test("throws NothingToCompactError under the minimum", async () => {
    const memory = makeFakeMemory(MIN_COMPACT_MESSAGES - 1) as any;
    await expect(
      forkThreadWithSummary("t1", { memory, summarize: async () => "S" }),
    ).rejects.toBeInstanceOf(NothingToCompactError);
  });

  test("forks into a new generation thread, leaves the parent intact, sets lineage metadata", async () => {
    const memory = makeFakeMemory(8) as any;
    const res = await forkThreadWithSummary("t1", { memory, summarize: async () => "SUMMARY" });

    expect(res).toEqual({
      parentThreadId: "t1",
      newThreadId: "t1~g2",
      generation: 2,
      summary: "SUMMARY",
    });

    // Parent thread untouched: no deleteMessages call, still present.
    expect(memory.deleted).toEqual([]);
    expect(memory.threads.has("t1")).toBe(true);

    // New generation thread created with lineage metadata.
    expect(memory.createThreadCalls.length).toBe(1);
    expect(memory.createThreadCalls[0]).toMatchObject({
      threadId: "t1~g2",
      resourceId: "raceiq",
      metadata: { base: "t1", generation: 2, parentThreadId: "t1" },
    });

    // Summary written into the NEW thread, not the parent.
    expect(memory.saved.length).toBe(1);
    expect(memory.saved[0].threadId).toBe("t1~g2");
    expect(memory.saved[0].content.content).toContain("SUMMARY");
    expect(memory.saved[0].content.metadata).toMatchObject({
      compacted: true,
      carriedOver: true,
      deterministic: true,
    });
  });

  test("picks the next generation after the newest existing one", async () => {
    const memory = makeFakeMemory(8) as any;
    // Simulate a lineage that already forked once: t1 (gen1) and t1~g2 exist.
    memory.threads.set("t1~g2", { id: "t1~g2" });

    const res = await forkThreadWithSummary("t1", { memory, summarize: async () => "SUMMARY" });

    expect(res.newThreadId).toBe("t1~g3");
    expect(res.generation).toBe(3);
    expect(res.parentThreadId).toBe("t1");
  });
});
