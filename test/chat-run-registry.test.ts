import { describe, expect, test } from "bun:test";
import { buildReplayStream, finishRun, pushChunk, reserveChatRun } from "../server/ai/chat-run-registry";

describe("chat run replay", () => {
  test("replays buffered chunks when run finishes before subscriber attaches", async () => {
    const { run } = reserveChatRun(`finished-before-attach-${crypto.randomUUID()}`);
    pushChunk(run, { type: "text-delta", id: "msg", delta: "reply" });
    finishRun(run);

    const reader = buildReplayStream(run).getReader();
    const first = await reader.read();

    expect(first.done).toBe(false);
    expect(first.value).toEqual({ type: "text-delta", id: "msg", delta: "reply" });
    await reader.cancel();
  });
});
