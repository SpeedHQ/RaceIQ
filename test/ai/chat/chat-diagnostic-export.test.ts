import { describe, expect, test } from "bun:test";
import { collectDiagnosticChatContext } from "../../../server/ai/chat-agent";

describe("diagnostic chat snapshot", () => {
  test("enumerates every thread and preserves raw messages", async () => {
    const memory = {
      listThreads: async () => ({ threads: [
        { id: "lap-2~g2", metadata: { raceiqSystemPrompt: "system" } },
        { id: "lap-2", metadata: {} },
      ] }),
      recall: async ({ threadId }: { threadId: string }) => ({ messages: [{ role: "user", content: { parts: [{ type: "text", text: threadId }] } }, { role: "tool", content: { input: { x: 1 } } }] }),
    };
    const snapshot = await collectDiagnosticChatContext(memory as never);
    expect(snapshot.error).toBeNull();
    expect(snapshot.threads.map((thread) => thread.thread)).toEqual([
      { id: "lap-2", metadata: {} },
      { id: "lap-2~g2", metadata: { raceiqSystemPrompt: "system" } },
    ]);
    expect(snapshot.messageCount).toBe(4);
    expect(snapshot.threads[1]?.messages[1]).toEqual({ role: "tool", content: { input: { x: 1 } } });
    expect(snapshot.threads[0]?.systemPromptUnavailable).toBe(true);
  });
});
