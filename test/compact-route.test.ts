import { describe, test, expect, mock } from "bun:test";
import { NothingToCompactError } from "../server/ai/compact-thread";
import { createChatsRoutes } from "../server/routes/chats-routes";

const forkThreadWithSummary = mock(async (threadId: string) => ({
  parentThreadId: threadId,
  newThreadId: `${threadId}~g2`,
  generation: 2,
  summary: "S",
}));
const chatsRoutes = createChatsRoutes(forkThreadWithSummary);

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
