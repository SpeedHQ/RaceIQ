import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { z } from "zod";

export const LapSummarySchema = z.object({
  id: z.number(),
  lapNumber: z.number(),
  trackOrdinal: z.number().nullable(),
  carOrdinal: z.number().nullable(),
});

export const ChatRowSchema = z.object({
  threadId: z.string(),
  type: z.enum(["analyse", "compare", "tune"]),
  laps: z.array(LapSummarySchema),
});

export const ChatListSchema = z.object({ chats: z.array(ChatRowSchema) });
export const ChatHistorySchema = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]) }).passthrough()),
});
export const ExperimentSchema = z.object({ id: z.number() });
export const LapSchema = z.object({ id: z.number(), isValid: z.boolean() });

export type ChatRow = z.infer<typeof ChatRowSchema>;
export type ChatMessage = { role: "user" | "assistant"; markdown: string };
export type DisposableChatMemory = {
  deleteThread: (id: string) => Promise<unknown>;
  getThreadById: (input: { threadId: string }) => Promise<unknown>;
};

export const SEEDED_CHAT_STREAM = [
  'data: {"type":"text-start","id":"seeded-text"}',
  "",
  'data: {"type":"text-delta","id":"seeded-text","delta":"Seeded streamed reply"}',
  "",
  'data: {"type":"text-end","id":"seeded-text"}',
  "",
  "data: [DONE]",
  "",
  "",
].join("\n");

export async function seededChats(request: APIRequestContext, gameId: string): Promise<ChatRow[]> {
  const response = await request.get(`/api/chats?gameId=${encodeURIComponent(gameId)}`);
  expect(response.ok(), `${gameId} chat list fixture response`).toBe(true);
  return ChatListSchema.parse(await response.json()).chats;
}

export async function openChatRow(page: Page, type: ChatRow["type"]): Promise<void> {
  const label = type === "tune" ? "setup" : type;
  const row = page.getByRole("row").filter({ has: page.getByText(label, { exact: true }) });
  await expect(row, `${type} chat row`).toHaveCount(1);
  await row.getByRole("button", { name: "Open", exact: true }).click();
}

export async function saveDisposableChat(threadId: string, messages: ChatMessage[]): Promise<DisposableChatMemory> {
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = resolve(process.env.PW_SEEDED_E2E_DATA_DIR ?? resolve(__dirname, "../../../test-results/test-data-seeded"));
  try {
    // Dynamic import required: production Memory singleton reads DATA_DIR during module initialization.
    const persistence = await import("../../../../server/ai/chat-agent");
    await persistence.saveChatMessages(threadId, messages);
    return persistence.getChatMemory() as DisposableChatMemory;
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
  }
}

export async function cleanupDisposableChat(request: APIRequestContext, threadId: string, memory: Pick<DisposableChatMemory, "deleteThread">): Promise<void> {
  try {
    const response = await request.delete(`/api/chats/${encodeURIComponent(threadId)}`);
    expect(response.ok(), `${threadId} cleanup response`).toBe(true);
  } finally {
    await memory.deleteThread(threadId);
  }
}
