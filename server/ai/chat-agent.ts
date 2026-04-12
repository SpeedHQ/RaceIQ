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
      return `google/${aiModel || "gemini-2.0-flash"}`;
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
