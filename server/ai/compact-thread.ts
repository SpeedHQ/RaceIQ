/**
 * Fork a chat thread: summarize the conversation with a bare model call,
 * create a new generation thread, and write the summary as its first tagged
 * message. The parent thread is left intact — it becomes read-only history.
 */
import { Agent } from "@mastra/core/agent";
import { MessageList } from "@mastra/core/agent";
import {
  getChatMemory,
  CHAT_RESOURCE_ID,
  getMastraModelId,
  parseThreadGeneration,
  generationThreadId,
} from "./chat-agent";
import { loadSettings } from "../settings";
import { getConfiguredAiProvider } from "./provider-runtime";
import { runCodexCli } from "./providers";

export const MIN_COMPACT_MESSAGES = 6;
export const COMPACT_SUMMARY_PREFIX = "🗜️ **Conversation compacted.**\n\n";

const SUMMARY_SYSTEM =
  "You are compacting a race-engineering chat. Produce a concise summary that " +
  "preserves: the car and track, any tune/setup facts and numbers discussed, " +
  "decisions the driver made, unresolved questions, and the driver's stated " +
  "goals. Use short bullet points. Do NOT add new advice. Output plain " +
  "markdown, no preamble.";

export class NothingToCompactError extends Error {
  constructor(message = "Not enough conversation to compact yet") {
    super(message);
    this.name = "NothingToCompactError";
  }
}

type Memory = ReturnType<typeof getChatMemory>;

export interface CompactDeps {
  memory?: Memory;
  summarize?: (transcript: string) => Promise<string>;
}

async function defaultSummarize(transcript: string): Promise<string> {
  const s = loadSettings();
  const runtime = await getConfiguredAiProvider("chat", s);
  if (runtime.provider === "codex") {
    const result = await runCodexCli(`${SUMMARY_SYSTEM}\n\n${transcript}`, runtime.model);
    return result.analysis;
  }
  const compactor = new Agent({
    id: "compactor",
    name: "Compactor",
    instructions: SUMMARY_SYSTEM,
    model: () => getMastraModelId(runtime.provider, runtime.model),
  });
  const result = await compactor.generate(transcript, {
    modelSettings: { maxOutputTokens: 900, temperature: 0 },
  });
  return typeof result.text === "string" ? result.text : "";
}

function textOf(msg: { parts?: Array<{ type: string; text?: string }> }): string {
  return (msg.parts ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

/**
 * Write the compacted-summary assistant message through the given memory
 * instance (mirrors `saveChatMessages`' shape but stays injectable — compact
 * must write and delete against the SAME memory, so the summary write can't go
 * through the hardcoded `getChatMemory()` singleton or a fake memory in tests
 * would never see it). Tags the row `compacted: true` so the client can render
 * a "conversation compacted" divider, and `deterministic: true` so the
 * reasoning-persistence poll skips it. Returns the new message id.
 */
async function writeSummaryMessage(memory: Memory, threadId: string, markdown: string): Promise<string> {
  const existing = await memory.getThreadById({ threadId });
  if (!existing) {
    await memory.createThread({ threadId, resourceId: CHAT_RESOURCE_ID });
  }
  type SaveMsg = Parameters<typeof memory.saveMessages>[0]["messages"][number];
  const id = crypto.randomUUID();
  const message = {
    id,
    role: "assistant",
    createdAt: new Date(),
    threadId,
    resourceId: CHAT_RESOURCE_ID,
    type: "text",
    content: {
      format: 2,
      parts: [{ type: "text", text: markdown }],
      content: markdown,
      metadata: { compacted: true, carriedOver: true, deterministic: true },
    },
  } as SaveMsg;
  await memory.saveMessages({ messages: [message] });
  return id;
}

export async function forkThreadWithSummary(
  threadId: string,
  deps: CompactDeps = {},
): Promise<{ parentThreadId: string; newThreadId: string; generation: number; summary: string }> {
  const memory = deps.memory ?? getChatMemory();
  const summarize = deps.summarize ?? defaultSummarize;

  const recalled = await memory.recall({ threadId });
  const raw = recalled.messages ?? [];

  const list = new MessageList({ threadId, resourceId: CHAT_RESOURCE_ID });
  list.add(raw as never, "memory");
  const ui = list.get.all.aiV5
    .ui()
    .filter((m) => m.role === "user" || m.role === "assistant");

  if (ui.length < MIN_COMPACT_MESSAGES) {
    throw new NothingToCompactError();
  }

  const transcript = ui
    .map((m) => `${m.role.toUpperCase()}: ${textOf(m as never)}`)
    .join("\n\n");

  const summary = await summarize(transcript);

  // Probe generations through the SAME (possibly injected) `memory` used
  // above, rather than the module-level `listThreadGenerations` helper — that
  // helper is bound to the process-global `getChatMemory()` singleton, which
  // would defeat dependency injection for tests. Mirrors its probe-upward
  // logic exactly; falls back to the passed-in thread's own generation when
  // nothing exists yet (shouldn't happen in practice — the thread being
  // forked must already exist to have been recalled above).
  const { base, gen: currentGen } = parseThreadGeneration(threadId);
  let maxGen = currentGen;
  for (let g = currentGen; ; g++) {
    const candidate = generationThreadId(base, g);
    const found = await memory.getThreadById({ threadId: candidate });
    if (!found) break;
    maxGen = g;
  }
  const generation = maxGen + 1;
  const newThreadId = generationThreadId(base, generation);

  await memory.createThread({
    threadId: newThreadId,
    resourceId: CHAT_RESOURCE_ID,
    metadata: { base, generation, parentThreadId: threadId },
  });

  await writeSummaryMessage(memory, newThreadId, COMPACT_SUMMARY_PREFIX + summary.trim());

  return { parentThreadId: threadId, newThreadId, generation, summary };
}
