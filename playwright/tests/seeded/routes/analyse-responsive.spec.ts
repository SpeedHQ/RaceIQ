import { expect, test } from "@playwright/test";
import { assertInputsInsideViewport, assertNoHorizontalOverflow, WORKSPACE_VIEWPORTS } from "../../support/responsive/assertions";

type LapTarget = { id: number; sessionId: number; isValid: boolean };

for (const viewport of WORKSPACE_VIEWPORTS) {
  test.describe(`${viewport.name} ${viewport.width}x${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    test("session Analyse remains reachable", async ({ page, request }) => {
      const response = await request.get("/api/laps?gameId=f1-2025");
      expect(response.ok()).toBe(true);
      const laps = (await response.json()) as LapTarget[];
      const lap = laps.find((candidate) => candidate.isValid);
      expect(lap, "seeded F1 session needs a valid lap").toBeDefined();

      await page.goto(`/f125/sessions/${lap!.sessionId}/replay/${lap!.id}`, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("lap-analyse-workspace")).toBeVisible();
      await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible();
      await expect(page.getByText("Desktop required")).toHaveCount(0);
      await expect(page.getByText("Rotate your device")).toHaveCount(0);
      await assertInputsInsideViewport(page, "lap-analyse-workspace", 1);
      await assertNoHorizontalOverflow(page);

      const lapSelector = page.getByRole("combobox", { name: "Search laps..." });
      await lapSelector.click();
      await expect(lapSelector).toBeFocused();
      await assertNoHorizontalOverflow(page);
    });
  });
}
