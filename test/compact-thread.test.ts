// test/compact-thread.test.ts
import { describe, test, expect } from "bun:test";
import { compactThread, NothingToCompactError, MIN_COMPACT_MESSAGES } from "../server/ai/compact-thread";

// Minimal fake Mastra memory: enough surface for compactThread.
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
  const deleted: string[] = [];
  const saved: any[] = [];
  return {
    deleted,
    saved,
    recall: async () => ({ messages: msgs }),
    getThreadById: async () => ({ id: "t1" }),
    createThread: async () => ({ id: "t1" }),
    saveMessages: async ({ messages }: any) => { saved.push(...messages); return { messages }; },
    deleteMessages: async (ids: string[]) => { deleted.push(...ids); },
  };
}

describe("compactThread", () => {
  test("throws NothingToCompactError under the minimum", async () => {
    const memory = makeFakeMemory(MIN_COMPACT_MESSAGES - 1) as any;
    await expect(
      compactThread("t1", { memory, summarize: async () => "S" }),
    ).rejects.toBeInstanceOf(NothingToCompactError);
  });

  test("summarizes, writes one summary, deletes originals in order", async () => {
    const memory = makeFakeMemory(8) as any;
    const res = await compactThread("t1", { memory, summarize: async () => "SUMMARY" });
    expect(res.before).toBe(8);
    expect(res.after).toBe(1);
    expect(res.summary).toBe("SUMMARY");
    // summary written before delete
    expect(memory.saved.length).toBe(1);
    expect(memory.saved[0].content.content).toContain("SUMMARY");
    // all 8 originals deleted, summary id not among them
    expect(memory.deleted.sort()).toEqual(["m0","m1","m2","m3","m4","m5","m6","m7"]);
    expect(memory.deleted).not.toContain(memory.saved[0].id);
  });

  test("rolls back the summary when the originals delete fails", async () => {
    const memory = makeFakeMemory(8) as any;
    // First deleteMessages call (the originals) throws; the rollback call
    // (deleting the just-written summary) succeeds and is recorded.
    let calls = 0;
    const rollbackDeleted: string[] = [];
    memory.deleteMessages = async (ids: string[]) => {
      calls += 1;
      if (calls === 1) throw new Error("delete boom");
      rollbackDeleted.push(...ids);
    };
    await expect(
      compactThread("t1", { memory, summarize: async () => "SUMMARY" }),
    ).rejects.toThrow("delete boom");
    // The summary write happened, then was rolled back — its id was passed to
    // the second (rollback) delete, leaving the thread untouched.
    expect(memory.saved.length).toBe(1);
    expect(rollbackDeleted).toEqual([memory.saved[0].id]);
  });
});
