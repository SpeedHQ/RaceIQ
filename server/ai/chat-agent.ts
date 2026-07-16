/**
 * Shared Mastra memory store + thread/model helpers.
 *
 * Agents themselves are defined in `mastra-instance.ts`; this module owns the
 * persistent memory (LibSQL), the thread-id helpers, and the provider→Mastra
 * model-id mapping that the dynamic model resolvers use.
 */
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { resolve } from "path";

/**
 * Resolve the chat memory db path. Uses DATA_DIR env override when set,
 * otherwise anchors on `process.cwd()` so the same `data/chat-memory.db` is
 * used by both the running server and `mastra dev` (which bundles into
 * `.mastra/output/` and breaks `import.meta.url`-based path resolution).
 */
function chatMemoryDbPath(): string {
  const root = process.env.DATA_DIR ?? resolve(process.cwd(), "data");
  return `file:${root}/chat-memory.db`;
}

// Singleton memory instance — stores chat threads in a separate SQLite file
const memory = new Memory({
  storage: new LibSQLStore({
    id: "chat-memory",
    url: chatMemoryDbPath(),
  }),
  options: { lastMessages: 50 },
});

/** Get the shared memory instance for direct thread management. */
export function getChatMemory() {
  return memory;
}

/**
 * Map app settings (aiProvider + aiModel) to a Mastra model ID string.
 * Mastra uses the format "provider/model-name".
 */
export function getMastraModelId(
  aiProvider: string,
  aiModel: string,
): string {
  switch (aiProvider) {
    case "gemini":
      return `google/${aiModel || "gemini-flash-latest"}`;
    case "openai":
      return `openai/${aiModel || "gpt-4o-mini"}`;
    case "local": {
      // Local models use OpenAI-compatible API; model ID passed through
      return `openai/${aiModel || "local-model"}`;
    }
    default: {
      // claude-cli fallback
      const claudeMap: Record<string, string> = {
        haiku: "anthropic/claude-haiku-3-5-20241022",
        sonnet: "anthropic/claude-sonnet-4-6",
        opus: "anthropic/claude-opus-4-6",
      };
      return claudeMap[aiModel] || "anthropic/claude-haiku-3-5-20241022";
    }
  }
}

/** Build the threadId for a lap's chat. */
export function chatThreadId(lapId: number): string {
  return `lap-${lapId}`;
}

/** Build the threadId for a tuning-session's setup chat (plan Phase D). */
export function tuneSessionThreadId(sessionId: number): string {
  return `tune-session-${sessionId}`;
}

/**
 * Build the threadId for a compare chat between two laps.
 * Uses canonical ordering (min,max) so order of selection doesn't matter.
 */
export function compareChatThreadId(idA: number, idB: number): string {
  const lo = Math.min(idA, idB);
  const hi = Math.max(idA, idB);
  return `compare-${lo}-${hi}`;
}

/** The resource ID used for all chat threads. */
export const CHAT_RESOURCE_ID = "raceiq";

/**
 * Persist a plain-markdown **assistant** message into a chat thread so it shows
 * up in the thread history the GET chat route reads back. Ensures the thread
 * exists first (mirrors how the streaming chat route auto-creates it via the
 * agent), then writes one message shaped as MastraMessageContentV2 — both a flat
 * `content` string and a `parts: [{type:"text"}]` array — so the GET route's
 * `mc.content ?? mc.parts.map(p => p.text).join("")` extractor reads it back
 * verbatim. Returns the saved message id.
 *
 * Used by the generate-from-chat route to post the applied-tweaks summary inline
 * in the setup conversation instead of a transient client-only card.
 */
export async function saveAssistantChatMessage(
  threadId: string,
  markdown: string,
): Promise<string> {
  const [id] = await saveChatMessages(threadId, [{ role: "assistant", markdown }]);
  return id;
}

/** Persist a plain-markdown **user** message into a chat thread. Same shape as
 * {@link saveAssistantChatMessage}; used to record deterministic user actions
 * (e.g. "Switch head to X" on checkout) as their own distinct entry. */
export async function saveUserChatMessage(
  threadId: string,
  markdown: string,
): Promise<string> {
  const [id] = await saveChatMessages(threadId, [{ role: "user", markdown }]);
  return id;
}

/** Persist an ordered batch of plain-markdown messages into a chat thread in a
 * single write. Batching keeps the requested order deterministic (each message
 * gets a strictly increasing createdAt) — a separate write per message can land
 * on the same millisecond and reorder on read. Distinct roles also stop the
 * MessageList reader collapsing consecutive same-role messages into one entry,
 * so a user+assistant pair renders as two separate turns. */
export async function saveChatMessages(
  threadId: string,
  entries: Array<{ role: "user" | "assistant"; markdown: string }>,
): Promise<string[]> {
  const mem = getChatMemory();
  const existing = await mem.getThreadById({ threadId });
  if (!existing) {
    await mem.createThread({ threadId, resourceId: CHAT_RESOURCE_ID });
  }
  // Derive the exact message shape saveMessages wants without importing the
  // (non-re-exported) MastraDBMessage type by name.
  type SaveMsg = Parameters<typeof mem.saveMessages>[0]["messages"][number];
  const base = Date.now();
  const messages = entries.map((entry, i) => {
    const id = crypto.randomUUID();
    return {
      id,
      role: entry.role,
      createdAt: new Date(base + i),
      threadId,
      resourceId: CHAT_RESOURCE_ID,
      type: "text",
      content: {
        format: 2,
        parts: [{ type: "text", text: entry.markdown }],
        content: entry.markdown,
      },
    } as SaveMsg;
  });
  await mem.saveMessages({ messages });
  return messages.map((m) => m.id);
}
