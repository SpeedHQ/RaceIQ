import { afterAll, describe, expect, test } from "bun:test";
import {
  CHAT_RESOURCE_ID,
  getChatMemory,
  saveAssistantChatMessage,
} from "../server/ai/chat-agent";

/**
 * Round-trip guard for the generate-from-chat "applied tweaks" message.
 *
 * The generate-from-chat route posts its applied-tweaks summary as an assistant
 * message via `saveAssistantChatMessage`, and the GET
 * `/api/experiments/:id/chat` route reads it back with a specific extractor.
 * This test proves the exact save shape survives `memory.recall` and yields the
 * markdown text through the SAME extraction the GET route uses — not empty.
 *
 * Uses the real memory store (chat-agent's singleton) against a throwaway thread
 * id, then deletes the thread so nothing leaks between runs.
 */

/** Mirror of the GET chat route's per-message text extraction (tune-routes.ts). */
function extractContent(m: { content: unknown }): string {
  const mc = m.content as any;
  if (typeof mc === "string") return mc;
  if (mc && typeof mc === "object") {
    return mc.content ?? mc.parts?.map((p: any) => p.text ?? "").join("") ?? "";
  }
  return "";
}

const threadId = `test-tune-chat-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

afterAll(async () => {
  try {
    await getChatMemory().deleteThread(threadId);
  } catch {
    /* best effort */
  }
});

describe("saveAssistantChatMessage round-trip", () => {
  test("recall returns the saved assistant markdown via the GET route extractor", async () => {
    const markdown =
      "**Applied — v3**\n" +
      "- Rear Anti-Roll Bar: 12 → 11\n" +
      "- Brake Bias: 55 → 54.5\n\n" +
      "Load `MySetup-v3.json` in-game from the setup menu.";

    const id = await saveAssistantChatMessage(threadId, markdown);
    expect(id).toBeTruthy();

    const memory = getChatMemory();
    const thread = await memory.getThreadById({ threadId });
    expect(thread).not.toBeNull();

    const result = await memory.recall({ threadId });
    const raw = result.messages ?? [];

    const assistantMessages = raw
      .filter((m) => m.role === "assistant")
      .map((m) => ({ role: m.role, content: extractContent(m) }));

    expect(assistantMessages.length).toBeGreaterThan(0);
    const texts = assistantMessages.map((m) => m.content);
    // The extractor must yield the full markdown, not an empty string.
    expect(texts).toContain(markdown);
    const found = texts.find((t) => t === markdown)!;
    expect(found).toContain("**Applied — v3**");
    expect(found).toContain("Rear Anti-Roll Bar: 12 → 11");
    expect(found.trim().length).toBeGreaterThan(0);
  });

  test("thread is created when absent, and resource id matches", async () => {
    const freshThread = `${threadId}-fresh`;
    try {
      await saveAssistantChatMessage(freshThread, "**Applied — v1**\n\nNo changes were needed — the setup already fits.\n\nLoad `Base-v1.json` in-game from the setup menu.");
      const thread = await getChatMemory().getThreadById({ threadId: freshThread });
      expect(thread).not.toBeNull();
      expect(thread?.resourceId).toBe(CHAT_RESOURCE_ID);
    } finally {
      try {
        await getChatMemory().deleteThread(freshThread);
      } catch {
        /* best effort */
      }
    }
  });
});
