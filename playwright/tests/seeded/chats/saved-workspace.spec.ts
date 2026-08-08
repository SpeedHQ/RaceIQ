import { expect, test } from "@playwright/test";
import { collectBrowserErrors } from "../../support/browser-errors";
import { ChatHistorySchema, openChatRow, seededChats } from "./helpers";

test("saved Analyse and Compare chats open their AI workspaces without a provider", async ({ page, request }) => {
  test.setTimeout(120_000);
  const browserErrors = collectBrowserErrors(page);
  const chats = await seededChats(request, "fm-2023");
  const analyse = chats.find((chat) => chat.type === "analyse");
  const compare = chats.find((chat) => chat.type === "compare");
  if (analyse?.laps.length !== 1) throw new Error("Missing seeded FM Analyse chat");
  if (compare?.laps.length !== 2) throw new Error("Missing seeded FM Compare chat");

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
  const analyseUrl = new URL(page.url());
  expect(analyseUrl.searchParams.get("track")).toBe(String(analyse.laps[0].trackOrdinal));
  expect(analyseUrl.searchParams.get("car")).toBe(String(analyse.laps[0].carOrdinal));
  expect(analyseUrl.searchParams.get("lap")).toBe(String(analyse.laps[0].id));
  expect(analyseUrl.searchParams.get("ai")).toBe("1");
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
