import { expect, test } from "@playwright/test";
import { completeOnboarding } from "./helpers";

test.describe("Setup Engineer experiments", () => {
  test("shows setup-seeded v1 immediately after session creation", async ({ page }) => {
    await page.goto("/");
    await completeOnboarding(page);

    const createResponse = await page.request.post("/api/experiments", {
      data: {
        gameId: "acc",
        name: "E2E setup-seeded experiment",
        carName: "e2e-car",
        trackName: "e2e-track",
        baseSetupPath: "fixtures/e2e-base.json",
        focus: "car",
      },
    });
    expect(createResponse.status()).toBe(201);
    const session = (await createResponse.json()) as {
      id: number;
      headVersionId: number | null;
    };

    const versionsResponse = await page.request.get(
      `/api/experiments/${session.id}/versions`,
    );
    expect(versionsResponse.ok()).toBeTruthy();
    const versions = (await versionsResponse.json()) as Array<{
      id: number;
      version: number;
      label: string;
      setupPath: string | null;
      kind: string;
    }>;
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      label: "v1",
      setupPath: "fixtures/e2e-base.json",
      kind: "setup",
    });
    expect(versions[0]?.id).toBe(session.headVersionId);

    await page.goto(`/acc/experiments/${session.id}`);
    await expect(page.getByText("v1", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Setup", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("HEAD", { exact: true })).toBeVisible();
    await expect(page.getByText(/No setup versions yet/)).toHaveCount(0);
  });
});
