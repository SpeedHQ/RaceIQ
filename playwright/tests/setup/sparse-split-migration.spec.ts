import { expect, test, type APIRequestContext } from "@playwright/test";

interface SplitMigrationStatus {
  sessionCount: number;
  progress: { status: "idle" | "running" | "success" | "partial" | "error" };
}

async function readStatus(request: APIRequestContext): Promise<SplitMigrationStatus> {
  const response = await request.get("/api/storage/split-migration");
  expect(response.ok(), "split migration status response").toBe(true);
  return response.json() as Promise<SplitMigrationStatus>;
}

test("complete startup sparse-split migration before seeded specs", async ({ page, request }) => {
  test.setTimeout(5 * 60_000);
  const initial = await readStatus(request);
  if (initial.sessionCount === 0) return;

  if (initial.progress.status !== "running") {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const dialog = page.getByRole("dialog", { name: "Split recordings for faster lap loading?" });
    await expect(dialog).toBeVisible();
    const accepted = page.waitForResponse((response) =>
      response.request().method() === "POST" && new URL(response.url()).pathname === "/api/storage/split-migration",
    );
    await dialog.getByRole("button", { name: "Split recordings", exact: true }).click();
    expect((await accepted).status()).toBe(202);
  }

  await expect.poll(async () => {
    const status = await readStatus(request);
    return { sessionCount: status.sessionCount, status: status.progress.status };
  }, { timeout: 5 * 60_000, intervals: [500, 1_000, 2_500] }).toEqual({ sessionCount: 0, status: "success" });
});
