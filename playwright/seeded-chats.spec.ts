import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { resolve } from "node:path";
import { z } from "zod";
import { SEEDED_GAME_CASES } from "./seeded-e2e-cases";
import { collectBrowserErrors } from "./seeded-e2e-helpers";

const LapSummarySchema = z.object({
  id: z.number(),
  lapNumber: z.number(),
});

const ChatRowSchema = z.object({
  threadId: z.string(),
  type: z.enum(["analyse", "compare", "tune"]),
  laps: z.array(LapSummarySchema),
});

const ChatListSchema = z.object({ chats: z.array(ChatRowSchema) });
const ChatHistorySchema = z.object({ messages: z.array(z.object({ role: z.enum(["user", "assistant"]) }).passthrough()) });

const SEEDED_CHAT_STREAM = [
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

async function seededChats(request: APIRequestContext, gameId: string) {
  const response = await request.get(`/api/chats?gameId=${encodeURIComponent(gameId)}`);
  expect(response.ok(), `${gameId} chat list fixture response`).toBe(true);
  return ChatListSchema.parse(await response.json()).chats;
}

async function openChatRow(page: Page, type: "analyse" | "compare" | "tune") {
  const label = type === "tune" ? "setup" : type;
  const row = page.getByRole("row").filter({ has: page.getByText(label, { exact: true }) });
  await expect(row, `${type} chat row`).toHaveCount(1);
  await row.getByRole("button", { name: "Open", exact: true }).click();
}

async function saveDisposableChat(threadId: string, messages: Array<{ role: "user" | "assistant"; markdown: string }>) {
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = resolve(
    process.env.PW_SEEDED_E2E_DATA_DIR ?? resolve(__dirname, "test-results", "test-data-seeded"),
  );
  try {
    // Production Memory singleton reads DATA_DIR during module initialization;
    // load after pointing at seeded server storage, not test runner's default data/.
    const persistence = await import("../server/ai/chat-agent");
    await persistence.saveChatMessages(threadId, messages);
    return persistence.getChatMemory();
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
  }
}
async function cleanupDisposableChat(
  request: APIRequestContext,
  threadId: string,
  memory: { deleteThread: (id: string) => Promise<unknown> },
) {
  try {
    const response = await request.delete(`/api/chats/${encodeURIComponent(threadId)}`);
    expect(response.ok(), `${threadId} cleanup response`).toBe(true);
  } finally {
    await memory.deleteThread(threadId);
  }
}

test("saved Analyse and Compare chats open their AI workspaces without a provider", async ({ page, request }) => {
  test.setTimeout(120_000);
  const browserErrors = collectBrowserErrors(page);
  const chats = await seededChats(request, "fm-2023");
  const analyse = chats.find((chat) => chat.type === "analyse");
  const compare = chats.find((chat) => chat.type === "compare");
  if (!analyse || analyse.laps.length !== 1) throw new Error("Missing seeded FM Analyse chat");
  if (!compare || compare.laps.length !== 2) throw new Error("Missing seeded FM Compare chat");

  const analyseHistoryResponse = await request.get(`/api/laps/${analyse.laps[0].id}/chat`);
  expect(analyseHistoryResponse.ok(), "seeded Analyse chat history response").toBe(true);
  expect(ChatHistorySchema.parse(await analyseHistoryResponse.json()).messages).toHaveLength(1);

  const compareHistoryResponse = await request.get(`/api/laps/${compare.laps[0].id}/compare/${compare.laps[1].id}/chat`);
  expect(compareHistoryResponse.ok(), "seeded Compare chat history response").toBe(true);
  expect(ChatHistorySchema.parse(await compareHistoryResponse.json()).messages).toHaveLength(1);

  await page.goto("/fm23/chats", { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Chat Sessions", exact: true })).toBeVisible();

  const analyseRow = page.getByRole("row").filter({ has: page.getByText("analyse", { exact: true }) });
  let deletePrompt = "";
  page.once("dialog", async (dialog) => {
    deletePrompt = dialog.message();
    await dialog.dismiss();
  });
  await analyseRow.getByTitle("Delete chat").click();
  expect(deletePrompt).toBe("Delete this chat session? Cached analysis is preserved.");
  await expect(analyseRow, "dismissed delete keeps chat row").toBeVisible();

  await openChatRow(page, "analyse");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/fm23/analyse");
  expect(new URL(page.url()).searchParams.get("lap")).toBe(String(analyse.laps[0].id));
  expect(new URL(page.url()).searchParams.get("ai")).toBe("1");
  await expect(page.locator("span").getByText("AI Analysis", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("AI not set up", { exact: true })).toBeVisible();

  await page.goto("/fm23/chats", { waitUntil: "domcontentloaded" });
  await openChatRow(page, "compare");
  await expect.poll(() => new URL(page.url()).pathname).toBe("/fm23/compare");
  expect(new URL(page.url()).searchParams.get("lapA")).toBe(String(compare.laps[0].id));
  expect(new URL(page.url()).searchParams.get("lapB")).toBe(String(compare.laps[1].id));
  expect(new URL(page.url()).searchParams.get("ai")).toBe("1");
  await expect(page.getByText("AI Compare", { exact: true })).toBeVisible({ timeout: 30_000 });

  expect(browserErrors.errors, "unexpected browser errors during saved chat flows").toEqual([]);
});

test("Setup chat submits a prompt and renders a streamed response", async ({ page, request }) => {
  const browserErrors = collectBrowserErrors(page);
  const experimentsResponse = await request.get("/api/experiments?gameId=f1-2025");
  expect(experimentsResponse.ok(), "seeded F1 tuning experiments").toBe(true);
  const experiment = z.array(z.object({ id: z.number() })).parse(await experimentsResponse.json())[0];
  if (!experiment) throw new Error("Missing seeded F1 experiment for streamed chat");

  const threadId = `tune-session-${experiment.id}`;
  let compacted = false;
  await page.route(`**/api/chats/${threadId}/generations`, (route) =>
    route.fulfill({
      json: {
        activeThreadId: compacted ? `${threadId}~g2` : threadId,
        generations: compacted
          ? [
              { threadId, generation: 1, active: false },
              { threadId: `${threadId}~g2`, generation: 2, active: true },
            ]
          : [{ threadId, generation: 1, active: true }],
      },
    }),
  );
  await page.route(`**/api/chats/${threadId}/compact`, async (route) => {
    compacted = true;
    await route.fulfill({ json: { generation: 2 } });
  });

  await page.route("**/api/settings", async (route) => {
    const response = await route.fetch();
    const settings = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: { ...settings, aiProvider: "local", aiModel: "seeded-e2e" },
    });
  });

  let submittedPrompt = "";
  await page.route(`**/api/experiments/${experiment.id}/chat*`, async (route) => {
    if (route.request().method() !== "POST") {
      const generation = new URL(route.request().url()).searchParams.get("gen");
      if (generation === "2") {
        await route.fulfill({ json: { messages: [] } });
      } else {
        await route.continue();
      }
      return;
    }
    submittedPrompt = route.request().postData() ?? "";
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      headers: {
        "cache-control": "no-cache",
        "x-vercel-ai-ui-message-stream": "v1",
      },
      body: SEEDED_CHAT_STREAM,
    });
  });

  await page.goto(`/f125/experiments/${experiment.id}`, { waitUntil: "domcontentloaded" });
  const prompt = "Explain this seeded setup";
  const messageInput = page.getByRole("textbox", { name: "Message input" });
  await expect(messageInput).toBeVisible({ timeout: 30_000 });
  await messageInput.fill(prompt);
  await page.getByRole("button", { name: "Send message" }).click();
  await expect.poll(() => submittedPrompt).toContain(prompt);
  await expect(page.getByText("Seeded streamed reply", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible();
  await page.getByRole("button", { name: "Compact & New chat" }).click();
  await expect.poll(() => compacted).toBe(true);
  await expect(page.getByText("gen 2/2", { exact: true })).toBeVisible();
  await expect(page.getByText("Seeded streamed reply", { exact: true })).toHaveCount(0);
  expect(browserErrors.errors, "unexpected browser errors during streamed chat").toEqual([]);
});

test("Chats route covers every seeded game and true empty state", async ({ page, request }) => {
  test.setTimeout(120_000);
  const browserErrors = collectBrowserErrors(page);

  for (const game of SEEDED_GAME_CASES) {
    const chats = await seededChats(request, game.gameId);
    await page.goto(`/${game.prefix}/chats`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Chat Sessions", exact: true })).toBeVisible();
    if (chats.length === 0) {
      await expect(page.getByText("No chat sessions yet", { exact: true })).toBeVisible();
    } else {
      await expect(page.getByText(`(${chats.length})`, { exact: true })).toBeVisible();
    }
  }

  expect(browserErrors.errors, "unexpected browser errors during game chat routes").toEqual([]);
});

test("Chats shows loading and error states from production list route", async ({ page }) => {
  test.setTimeout(120_000);
  let releaseLoading: (() => void) | undefined;
  const loadingReleased = new Promise<void>((resolve) => {
    releaseLoading = resolve;
  });
  await page.route("**/api/chats?gameId=iracing", async (route) => {
    await loadingReleased;
    await route.continue();
  });
  await page.goto("/iracing/chats", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("Loading...", { exact: true })).toBeVisible();
  releaseLoading?.();
  await expect(page.getByText("No chat sessions yet", { exact: true })).toBeVisible();
  await page.unroute("**/api/chats?gameId=iracing");

  await page.route("**/api/chats?gameId=iracing", (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "seeded fault" }) }),
  );
  await page.goto("/iracing/chats", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("HTTP 500", { exact: true })).toBeVisible();
  await page.unroute("**/api/chats?gameId=iracing");
});

test("disposable Analyse and tune threads delete through production persistence", async ({ page, request }) => {
  test.setTimeout(120_000);
  const browserErrors = collectBrowserErrors(page);
  const fmChats = await seededChats(request, "fm-2023");
  const lapResponse = await request.get("/api/laps?gameId=fm-2023");
  expect(lapResponse.ok(), "FM lap list for disposable chat").toBe(true);
  const laps = z.array(z.object({ id: z.number(), isValid: z.boolean() })).parse(await lapResponse.json());
  const existingThreadIds = new Set(fmChats.map((chat) => chat.threadId));
  const disposableLap = laps.find((lap) => lap.isValid && !existingThreadIds.has(`lap-${lap.id}`));
  if (!disposableLap) throw new Error("No disposable seeded FM lap available for chat deletion");

  const analyseThreadId = `lap-${disposableLap.id}`;
  const analyseMemory = await saveDisposableChat(analyseThreadId, [
    { role: "user", markdown: "Disposable seeded chat question" },
  ]);
  try {
    const created = await seededChats(request, "fm-2023");
    expect(created.some((chat) => chat.threadId === analyseThreadId && chat.type === "analyse")).toBe(true);
    const history = await request.get(`/api/laps/${disposableLap.id}/chat`);
    expect(history.ok(), "disposable chat history response").toBe(true);
    expect(ChatHistorySchema.parse(await history.json()).messages).toHaveLength(1);

    await page.goto("/fm23/chats", { waitUntil: "domcontentloaded" });
    const row = page.getByTestId(`chat-row-${analyseThreadId}`);
    await expect(row).toHaveCount(1);
    page.once("dialog", (dialog) => dialog.accept());
    await row.getByTitle("Delete chat").click();
    await expect(row).toHaveCount(0);
    expect((await seededChats(request, "fm-2023")).some((chat) => chat.threadId === analyseThreadId)).toBe(false);
    expect(await analyseMemory.getThreadById({ threadId: analyseThreadId })).toBeNull();
  } finally {
    await cleanupDisposableChat(request, analyseThreadId, analyseMemory);
  }

  const experimentsResponse = await request.get("/api/experiments?gameId=f1-2025");
  expect(experimentsResponse.ok(), "seeded F1 tuning experiments").toBe(true);
  const experiments = z.array(z.object({ id: z.number() })).parse(await experimentsResponse.json());
  const experiment = experiments[0];
  if (!experiment) throw new Error("Missing seeded F1 experiment for tune chat");
  const tuneThreadId = `tune-session-${experiment.id}`;
  const existingTune = await seededChats(request, "f1-2025");
  if (existingTune.some((chat) => chat.threadId === tuneThreadId)) {
    throw new Error(`Seeded F1 tune thread is not disposable: ${tuneThreadId}`);
  }
  const tuneMemory = await saveDisposableChat(tuneThreadId, [
    { role: "user", markdown: "Disposable setup question" },
  ]);
  try {
    const tuneChats = await seededChats(request, "f1-2025");
    expect(tuneChats.some((chat) => chat.threadId === tuneThreadId && chat.type === "tune")).toBe(true);
    const tuneHistory = await request.get(`/api/experiments/${experiment.id}/chat`);
    expect(tuneHistory.ok(), "disposable tune history response").toBe(true);
    expect(ChatHistorySchema.parse(await tuneHistory.json()).messages).toHaveLength(1);
    await page.goto("/f125/chats", { waitUntil: "domcontentloaded" });
    await openChatRow(page, "tune");
    await expect.poll(() => new URL(page.url()).pathname).toBe(`/f125/experiments/${experiment.id}`);
    await page.goto("/f125/chats", { waitUntil: "domcontentloaded" });
    const tuneRow = page.getByTestId(`chat-row-${tuneThreadId}`);
    await expect(tuneRow).toHaveCount(1);
    page.once("dialog", (dialog) => dialog.accept());
    await tuneRow.getByTitle("Delete chat").click();
    await expect(tuneRow).toHaveCount(0);
    expect((await seededChats(request, "f1-2025")).some((chat) => chat.threadId === tuneThreadId)).toBe(false);
    expect(await tuneMemory.getThreadById({ threadId: tuneThreadId })).toBeNull();
  } finally {
    await cleanupDisposableChat(request, tuneThreadId, tuneMemory);
  }

  expect(browserErrors.errors, "unexpected browser errors during disposable chat flows").toEqual([]);
});
