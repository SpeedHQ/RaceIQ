import { describe, test, expect, mock } from "bun:test";

// Mock compact-thread before importing the routes so the route uses the stub.
const compactThread = mock(async (threadId: string) => ({ summary: "S", before: 8, after: 1 }));
class NothingToCompactError extends Error { constructor(m?: string){ super(m); this.name = "NothingToCompactError"; } }
mock.module("../server/ai/compact-thread", () => ({ compactThread, NothingToCompactError }));

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
