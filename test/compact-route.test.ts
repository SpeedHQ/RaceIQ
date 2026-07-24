import { describe, test, expect, mock } from "bun:test";

// Mock the runner seam (not compact-thread.ts directly) so this global module
// mock does not bleed into compact-thread.test.ts. The route imports
// forkThreadWithSummary through ../ai/compact-thread-runner; compact-thread.test.ts
// imports the real ../server/ai/compact-thread — different module keys.
const forkThreadWithSummary = mock(async (threadId: string) => ({
  parentThreadId: threadId,
  newThreadId: `${threadId}~g2`,
  generation: 2,
  summary: "S",
}));
class NothingToCompactError extends Error { constructor(m?: string){ super(m); this.name = "NothingToCompactError"; } }
mock.module("../server/ai/compact-thread-runner", () => ({ forkThreadWithSummary, NothingToCompactError }));

const { chatsRoutes } = await import("../server/routes/chats-routes");

describe("POST /api/chats/:threadId/compact", () => {
  test("200 with the new fork shape", async () => {
    const res = await chatsRoutes.request("/api/chats/lap-1/compact", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      parentThreadId: "lap-1",
      newThreadId: "lap-1~g2",
      generation: 2,
      summary: "S",
    });
  });

  test("422 when nothing to compact", async () => {
    forkThreadWithSummary.mockImplementationOnce(async () => { throw new NothingToCompactError("nope"); });
    const res = await chatsRoutes.request("/api/chats/lap-1/compact", { method: "POST" });
    expect(res.status).toBe(422);
  });
});
