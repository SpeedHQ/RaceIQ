import { expect, test } from "bun:test";
import { buildChatExport, ensureSystemPrompt, type ChatExportMemory } from "../server/ai/chat-agent";

test("ensureSystemPrompt persists system prompt before existing transcript only once", async () => {
  const messages: any[] = [
    { id: "u1", role: "user", createdAt: new Date(2_000), content: { content: "hello" } },
  ];
  const memory: ChatExportMemory = {
    async recall() {
      return { messages };
    },
    async saveMessages(input) {
      messages.unshift(...input.messages);
    },
  };

  await ensureSystemPrompt("thread", "system instructions", memory);
  await ensureSystemPrompt("thread", "system instructions", memory);

  expect(messages.filter((message) => message.role === "system")).toHaveLength(1);
  expect(messages[0].role).toBe("system");
  expect(messages[0].content.content).toBe("system instructions");
});

test("chat export keeps system, tool, and reasoning records", () => {
  const transcript = [
    { role: "system", content: { content: "system" } },
    { role: "user", content: { content: "question" } },
    { role: "assistant", content: { parts: [{ type: "reasoning", text: "think" }] } },
    { role: "tool", content: { parts: [{ type: "tool-result", result: "answer" }] } },
  ];

  expect(buildChatExport(transcript)).toEqual({ messages: transcript });
});
