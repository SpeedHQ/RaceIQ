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

/** Build the threadId for a experiment's setup chat (plan Phase D). */
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

/** Mastra stream options required to persist turns in the requested thread. */
export function chatMemoryOptions(threadId: string) {
  return { memory: { thread: threadId, resource: CHAT_RESOURCE_ID } } as const;
}

export type ChatExportMemory = {
  recall(args: { threadId: string }): Promise<{ messages?: unknown[] }>;
  saveMessages(args: { messages: unknown[] }): Promise<unknown>;
  getThreadById?: (args: { threadId: string }) => Promise<unknown>;
  createThread?: (args: { threadId: string; resourceId: string }) => Promise<unknown>;
};

/** Persist one thread's system prompt so exports begin with model instructions. */
export async function ensureSystemPrompt(
  threadId: string,
  systemPrompt: string,
  mem: ChatExportMemory = memory,
): Promise<void> {
  if (!systemPrompt.trim()) return;
  const existing = (await mem.recall({ threadId })).messages ?? [];
  if (existing.some((message: any) => message?.role === "system")) return;
  if (existing.length === 0 && mem.getThreadById && mem.createThread && !(await mem.getThreadById({ threadId }))) {
    await mem.createThread({ threadId, resourceId: CHAT_RESOURCE_ID });
  }
  await mem.saveMessages({
    messages: [{
      id: crypto.randomUUID(),
      role: "system",
      createdAt: new Date(0),
      threadId,
      resourceId: CHAT_RESOURCE_ID,
      type: "text",
      content: {
        format: 2,
        parts: [{ type: "text", text: systemPrompt }],
        content: systemPrompt,
      },
    }],
  });
}

/** Export raw Mastra records without dropping tool calls or reasoning parts. */
export function buildChatExport<T>(messages: T[]) {
  return { messages };
}

// ─── Chat generations ──────────────────────────────────────────────────────
//
// A chat surface (lap / compare / experiment) can accumulate multiple
// "generations" over its lifetime. Generation 1 keeps the plain base id
// (`lap-42`) so existing single-thread chats stay valid with no migration.
// Later generations suffix `~g<N>` (`lap-42~g2`). `~g` is deliberately NOT a
// dash — a dash would break the `-`-split parsing of compare ids elsewhere —
// and is URL-unreserved so it survives `encodeURIComponent` in route params.
//
// The newest generation is the only writable one; older gens are a read-only
// archive. "Active" is derived by probing (`resolveActiveThread`) rather than
// stored — the deterministic id scheme makes probing cheap and keeps lineage
// out of any SQL table (it also rides on Mastra thread metadata at creation).

const GEN_SEP = "~g";

/** Split a (possibly suffixed) thread id into its base id and generation number. */
export function parseThreadGeneration(threadId: string): { base: string; gen: number } {
  const idx = threadId.lastIndexOf(GEN_SEP);
  if (idx === -1) return { base: threadId, gen: 1 };
  const gen = Number(threadId.slice(idx + GEN_SEP.length));
  if (!Number.isInteger(gen) || gen < 2) return { base: threadId, gen: 1 };
  return { base: threadId.slice(0, idx), gen };
}

/** Build the thread id for a given base + generation. Gen 1 is the bare base. */
export function generationThreadId(base: string, gen: number): string {
  return gen <= 1 ? base : `${base}${GEN_SEP}${gen}`;
}

/**
 * Minimal structural view of the memory these thread-probing helpers need.
 * Satisfied by the real Mastra `Memory` and by a plain fake in tests, so tests
 * can inject a store instead of reaching for `mock.module` — which is
 * PROCESS-global in Bun and would hand a stubbed `getChatMemory()` to every
 * later test file in the run.
 */
export type ThreadProbeMemory = {
  getThreadById(args: { threadId: string }): Promise<{ id: string } | null>;
};

/**
 * List the existing generations for a base, ordered oldest→newest. Probes
 * upward from gen 1 (= base) until the first missing generation. Empty when the
 * base has never been chatted (no thread exists yet).
 *
 * `mem` defaults to the shared `getChatMemory()` singleton; pass a fake to
 * probe an alternate store (tests).
 */
export async function listThreadGenerations(
  base: string,
  mem: ThreadProbeMemory = getChatMemory(),
): Promise<Array<{ threadId: string; generation: number }>> {
  const out: Array<{ threadId: string; generation: number }> = [];
  for (let gen = 1; ; gen++) {
    const threadId = generationThreadId(base, gen);
    const thread = await mem.getThreadById({ threadId });
    if (!thread) break;
    out.push({ threadId, generation: gen });
  }
  return out;
}

/**
 * Resolve the active (newest existing) thread id for a base. Returns the base
 * (gen 1) when nothing exists yet, so a first POST auto-creates gen 1 exactly
 * as before.
 */
export async function resolveActiveThread(
  base: string,
  mem: ThreadProbeMemory = getChatMemory(),
): Promise<string> {
  const gens = await listThreadGenerations(base, mem);
  return gens.length ? gens[gens.length - 1].threadId : base;
}

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
        // Mark as a deterministic, tool/route-emitted note. These land in the
        // thread *during* an agent turn (e.g. a tool posting a note
        // per fork), so their createdAt can be newer than Mastra's trailing save
        // of the model's own assistant row. The reasoning-persistence poll must
        // not mistake one of these for the model's response and stamp a phantom
        // thinking block onto it — it skips any row carrying this flag.
        metadata: { deterministic: true },
      },
    } as SaveMsg;
  });
  await mem.saveMessages({ messages });
  return messages.map((m) => m.id);
}
export type ChatMutationMemory = {
  recall(args: { threadId: string; perPage?: false }): Promise<{ messages?: unknown[] }>;
  deleteMessages(input: string[]): Promise<void>;
};

function messageText(message: any): string {
  if (typeof message?.content === "string") return message.content;
  if (typeof message?.content?.content === "string") return message.content.content;
  return Array.isArray(message?.content?.parts)
    ? message.content.parts.filter((part: any) => part?.type === "text").map((part: any) => part.text ?? "").join("")
    : "";
}

/** Retain history through one user prompt and remove its response and all later messages. */
export async function truncateChatAfterUserMessage(
  threadId: string,
  messageId: string,
  mem: ChatMutationMemory = getChatMemory(),
): Promise<{ messages: unknown[]; prompt: string }> {
  const messages = (await mem.recall({ threadId, perPage: false })).messages ?? [];
  const selectedIndex = messages.findIndex((message: any) => message?.id === messageId && message?.role === "user");
  if (selectedIndex < 0) throw new Error("User message not found");

  const removed = messages.slice(selectedIndex + 1);
  if (removed.length) await mem.deleteMessages(removed.map((message: any) => message.id));
  return { messages: messages.slice(0, selectedIndex + 1), prompt: messageText(messages[selectedIndex]) };
}
