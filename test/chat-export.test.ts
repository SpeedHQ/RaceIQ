import { expect, test } from "bun:test";
import { buildChatExport, chatMemoryMessagesToUiMessages, ensureSystemPrompt, type ChatExportMemory } from "../server/ai/chat-agent";

test("ensureSystemPrompt stores prompt in thread metadata only once", async () => {
  let thread: { id: string; title: string; metadata?: Record<string, unknown> } | null = null;
  const memory: ChatExportMemory = {
    async recall() { return { messages: [] }; }, async saveMessages() {},
    async getThreadById() { return thread; },
    async createThread(input) { thread = { id: input.threadId, title: "", metadata: input.metadata }; },
    async updateThread(input) { thread = { id: input.id, title: input.title, metadata: input.metadata }; },
  };
  await ensureSystemPrompt("thread", "system instructions", memory);
  await ensureSystemPrompt("thread", "changed", memory);
  expect(thread?.metadata?.raceiqSystemPrompt).toBe("system instructions");
});

test("chat export and hydration preserve raw ordered parts", () => {
  const assistant = { role: "assistant", content: { parts: [
    { type: "reasoning", reasoning: "think one" },
    { type: "tool-getTrackGuideTool", toolCallId: "t1", state: "output-available", input: { track: "x" }, output: { ok: true } },
    { type: "reasoning", details: [{ type: "text", text: "think two" }] },
    { type: "text", text: "final" },
  ] } };
  const hydrated = chatMemoryMessagesToUiMessages([assistant]) as Array<{ parts: unknown[] }>;
  expect(hydrated[0].parts).toHaveLength(4);
  expect((hydrated[0].parts[0] as { text: string }).text).toBe("think one");
  expect((hydrated[0].parts[2] as { text: string }).text).toBe("think two");
  expect(buildChatExport("system", [assistant]).messages[0]).toEqual({ role: "system", content: { format: 2, parts: [{ type: "text", text: "system" }], content: "system" } });
  expect(buildChatExport("system", [assistant]).messages[1]).toEqual(assistant);
});
