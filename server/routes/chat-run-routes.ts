import { Hono } from "hono";
import { createUIMessageStreamResponse } from "ai";
import { buildReplayStream, getRun } from "../ai/chat-run-registry";

/**
 * Detached-run status/resume/cancel endpoints, generic across every chat
 * surface (lap chat, compare chat, tune-session chat — all keyed by the
 * same Mastra threadId used elsewhere, e.g. `../ai/chat-agent.ts`'s
 * `chatThreadId`/`compareChatThreadId`/`tuneSessionThreadId`).
 *
 * Only tune-session chat currently starts runs via `startDetachedAgentTurn`
 * (see tune-chat-routes.ts) — these routes are harmless no-ops (`none`/204)
 * for threads that never went through the detached path.
 */
export const chatRunRoutes = new Hono()
  // GET /api/chats/:threadId/run — status of any run for this thread.
  .get("/api/chats/:threadId/run", async (c) => {
    const threadId = c.req.param("threadId");
    const run = getRun(threadId);
    if (!run) return c.json({ status: "none" as const });
    return c.json({ status: run.status, runId: run.runId });
  })

  // GET /api/chats/:threadId/run/stream — replay buffered chunks then live-tail.
  // Matches the exact wire format of the original turn's response so the
  // client's transport parses a reconnect identically to a fresh stream.
  // 204 (no body) when there's nothing to resume — the AI SDK's
  // `HttpChatTransport.reconnectToStream` treats that as "nothing active".
  .get("/api/chats/:threadId/run/stream", async (c) => {
    const threadId = c.req.param("threadId");
    const run = getRun(threadId);
    if (!run) return c.body(null, 204);
    return createUIMessageStreamResponse({ stream: buildReplayStream(run) });
  })

  // POST /api/chats/:threadId/run/cancel — abort the active run, if any.
  .post("/api/chats/:threadId/run/cancel", async (c) => {
    const threadId = c.req.param("threadId");
    const run = getRun(threadId);
    if (!run || run.status === "finished") {
      return c.json({ ok: true, status: "finished" as const });
    }
    run.abortController.abort();
    return c.json({ ok: true, status: "cancelling" as const });
  });
