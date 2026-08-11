import { expect, test } from "@playwright/test";
import { z } from "zod";
import { collectBrowserErrors } from "../../support/browser-errors";
import { ChatHistorySchema, ExperimentSchema, LapSchema, cleanupDisposableChat, openChatRow, saveDisposableChat, seededChats } from "./helpers";

test("disposable Analyse and tune threads delete through production persistence", async ({ page, request }) => {
  test.setTimeout(120_000);
  const browserErrors = collectBrowserErrors(page);
  const fmChats = await seededChats(request, "fm-2023");
  const lapResponse = await request.get("/api/laps?gameId=fm-2023");
  expect(lapResponse.ok(), "FM lap list for disposable chat").toBe(true);
  const laps = z.array(LapSchema).parse(await lapResponse.json());
  const existingThreadIds = new Set(fmChats.map((chat) => chat.threadId));
  const disposableLap = laps.find((lap) => lap.isValid && !existingThreadIds.has(`lap-${lap.id}`));
  if (!disposableLap) throw new Error("No disposable seeded FM lap available for chat deletion");

  const analyseThreadId = `lap-${disposableLap.id}`;
  const analyseMemory = await saveDisposableChat(analyseThreadId, [{ role: "user", markdown: "Disposable seeded chat question" }]);
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
  const experiments = z.array(ExperimentSchema).parse(await experimentsResponse.json());
  const experiment = experiments[0];
  if (!experiment) throw new Error("Missing seeded F1 experiment for tune chat");
  const tuneThreadId = `tune-session-${experiment.id}`;
  const existingTune = await seededChats(request, "f1-2025");
  if (existingTune.some((chat) => chat.threadId === tuneThreadId)) {
    throw new Error(`Seeded F1 tune thread is not disposable: ${tuneThreadId}`);
  }
  const tuneMemory = await saveDisposableChat(tuneThreadId, [{ role: "user", markdown: "Disposable setup question" }]);
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
