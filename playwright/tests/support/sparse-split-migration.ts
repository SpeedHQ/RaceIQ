import { expect, type Page } from "@playwright/test";

type MigrationStatus = {
  sessionCount: number;
  progress: { status: "idle" | "running" | "success" | "partial" | "error" };
};

export async function startSparseSplitMigration(page: Page): Promise<void> {
  const readStatus = async (): Promise<MigrationStatus> => {
    const response = await page.request.get("/api/storage/split-migration");
    if (!response.ok()) {
      throw new Error(`Split migration status failed (${response.status()})`);
    }
    return response.json() as Promise<MigrationStatus>;
  };

  const status = await readStatus();
  if (status.sessionCount === 0 || status.progress.status === "running" || status.progress.status === "success") return;

  const actionName = status.progress.status === "idle" ? "Split recordings" : "Retry unfinished sessions";
  const action = page.getByRole("button", { name: actionName, exact: true });
  await expect(action).toBeVisible({ timeout: 15_000 });
  await action.click();
  await expect.poll(async () => (await readStatus()).progress.status, { timeout: 15_000 }).toMatch(/^(running|success)$/);
}
