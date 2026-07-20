import { describe, test, expect, mock } from "bun:test";

// Mock the runner seam (not compact-thread.ts directly) so this global module
// mock does not bleed into compact-thread.test.ts. The route imports
// compactThread through ../ai/compact-thread-runner; compact-thread.test.ts
// imports the real ../server/ai/compact-thread — different module keys.
const compactThread = mock(async (_threadId: string) => ({ summary: "S", before: 8, after: 1 }));
class NothingToCompactError extends Error { constructor(m?: string){ super(m); this.name = "NothingToCompactError"; } }
mock.module("../server/ai/compact-thread-runner", () => ({ compactThread, NothingToCompactError }));

const { chatsRoutes } = await import("../server/routes/chats-routes");

describe("POST /api/chats/:threadId/compact", () => {
  test("200 with summary payload", async () => {
    const res = await chatsRoutes.request("/api/chats/lap-1/compact", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ summary: "S", before: 8, after: 1 });
  });

  test("422 when nothing to compact", async () => {
    compactThread.mockImplementationOnce(async () => { throw new NothingToCompactError("nope"); });
    const res = await chatsRoutes.request("/api/chats/lap-1/compact", { method: "POST" });
    expect(res.status).toBe(422);
  });
});
