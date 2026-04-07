/**
 * Mastra-powered chat agent for follow-up Q&A on lap analysis.
 * Uses Mastra Memory (LibSQL) for persistent conversation history.
 */
import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { resolveDataDir } from "../data-dir";

// Singleton memory instance — stores chat threads in a separate SQLite file
const memory = new Memory({
  storage: new LibSQLStore({
    id: "chat-memory",
    url: `file:${resolveDataDir()}/chat-memory.db`,
  }),
  options: { lastMessages: 50 },
});

/**
 * Create a Mastra Agent configured for racing engineer chat.
 * The agent is created per-request so the system prompt can include
 * lap-specific telemetry context.
 */
export function createChatAgent(systemPrompt: string, modelId: string) {
  return new Agent({
    id: "racing-engineer",
    name: "Racing Engineer",
    instructions: systemPrompt,
    model: modelId,
    memory,
  });
}

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

/** The resource ID used for all chat threads. */
export const CHAT_RESOURCE_ID = "raceiq";
