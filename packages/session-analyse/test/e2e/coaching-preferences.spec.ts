import { decodeAlignedLapSet } from "@raceiq/analysis-core/racing/laps/alignment/codec";
import { expect, test } from "@playwright/test";
import { importCoachingRecording } from "./coaching-fixtures";

test("coaching evidence follows persisted language and speed units without changing source telemetry", async ({ page, request }) => {
  const settingsResponse = await request.get("/api/settings");
  expect(settingsResponse.ok()).toBe(true);
  const originalSettings = await settingsResponse.json() as Record<string, unknown>;
  const fixture = await importCoachingRecording(request, {
    label: `coaching-preferences-${Date.now()}`,
    lapCount: 1,
    signals: ["brake-drag"],
  });
  const updateSettings = async (settings: Record<string, unknown>) => {
    const response = await request.put("/api/settings", { data: settings });
    expect(response.ok()).toBe(true);
  };
  try {
    await updateSettings({ language: "de", unit: "imperial", temperatureUnit: "F" });
    await page.goto(`/iracing/sessions/${fixture.sessionId}/analyse`, { waitUntil: "domcontentloaded" });
    const section = page.getByTestId("three-to-improve");
    await expect(section).toBeVisible();
    const card = section.locator('[data-coaching-family="brake-drag"]');
    await expect(card).toContainText("Prüfe, ob die Bremse beim Beschleunigen vollständig gelöst ist.");
    const evidenceButton = card.getByRole("button");
    await evidenceButton.focus();
    await page.keyboard.press("Enter");
    const evidence = page.getByTestId("three-to-improve-evidence");
    await expect(evidence).toBeVisible();
    const speedChart = evidence.getByTestId("coaching-evidence-chart").locator('[data-channel="speed"]');
    await expect(speedChart).toContainText("mph");
    await expect(speedChart).toContainText("149.13");
    await evidence.getByRole("button", { name: /close|schließen/i }).focus();
    await page.keyboard.press("Escape");
    await expect(evidence).toHaveCount(0);
    await expect(evidenceButton).toBeFocused();

    await updateSettings({ unit: "metric" });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(section).toBeVisible();
    const metricCard = section.locator('[data-coaching-family="brake-drag"]');
    const metricEvidenceButton = metricCard.getByRole("button");
    await metricEvidenceButton.focus();
    await page.keyboard.press("Enter");
    const metricEvidence = page.getByTestId("three-to-improve-evidence");
    await expect(metricEvidence).toBeVisible();
    const metricSpeedChart = metricEvidence.getByTestId("coaching-evidence-chart").locator('[data-channel="speed"]');
    await expect(metricSpeedChart).toContainText("km/h");
    await expect(metricSpeedChart).toContainText("240");

    const summaryResponse = await request.get(`/api/sessions/${fixture.sessionId}/3-to-improve`, { headers: { "X-Game-Id": "iracing" } });
    expect(summaryResponse.ok()).toBe(true);
    const summary = await summaryResponse.json() as { items: Array<{ representative: { lapId: number; sourceFrameIndex: number } }> };
    const representative = summary.items[0]!.representative;
    const telemetryResponse = await request.get(
      `/api/sessions/${fixture.sessionId}/3-to-improve/evidence?lapId=${representative.lapId}&sourceFrameIndex=${representative.sourceFrameIndex}`,
      { headers: { "X-Game-Id": "iracing" } },
    );
    expect(telemetryResponse.ok()).toBe(true);
    const detail = await telemetryResponse.json() as { aligned: Parameters<typeof decodeAlignedLapSet>[0] };
    const aligned = decodeAlignedLapSet(detail.aligned);
    expect(aligned.laps[0]!.speedMps.some((speed) => Math.abs(speed - 4_000 / 60) < 0.01)).toBe(true);
  } finally {
    try {
      await updateSettings({
        language: originalSettings.language,
        unit: originalSettings.unit,
        temperatureUnit: originalSettings.temperatureUnit,
      });
    } finally {
      await fixture.cleanup();
    }
  }
});
test("coaching scope follows lap exclusion through production mutation endpoint", async ({ page, request }) => {
  const fixture = await importCoachingRecording(request, {
    label: `coaching-exclusion-${Date.now()}`,
    lapCount: 3,
    signals: ["brake-drag"],
  });
  let representativeLapId: number | undefined;
  try {
    await page.goto(`/iracing/sessions/${fixture.sessionId}/analyse`, { waitUntil: "domcontentloaded" });
    const section = page.getByTestId("three-to-improve");
    await expect(section).toBeVisible();
    await expect(section.locator('[data-coaching-family="brake-drag"]')).toContainText("Observed on 3 laps");
    await expect(section).toContainText("3 of 3 eligible laps analyzed");
    const lapsResponse = await request.get("/api/laps?gameId=iracing");
    expect(lapsResponse.ok()).toBe(true);
    const laps = await lapsResponse.json() as Array<{ id: number; sessionId: number; lapNumber: number }>;
    const fixtureLaps = laps.filter((lap) => lap.sessionId === fixture.sessionId);
    expect(fixtureLaps).toHaveLength(3);
    representativeLapId = fixtureLaps[0]!.id;

    const exclude = await request.post(`/api/laps/${representativeLapId}/experiment-excluded`, { data: { excluded: true } });
    expect(exclude.ok()).toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    const excludedCard = section.locator('[data-coaching-family="brake-drag"]');
    await expect(excludedCard).toContainText("Observed on 2 laps");
    await expect(section).toContainText("2 of 2 eligible laps analyzed");

    const include = await request.post(`/api/laps/${representativeLapId}/experiment-excluded`, { data: { excluded: false } });
    expect(include.ok()).toBe(true);
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(section.locator('[data-coaching-family="brake-drag"]')).toContainText("Observed on 3 laps");
    await expect(section).toContainText("3 of 3 eligible laps analyzed");
  } finally {
    if (representativeLapId != null) {
      await request.post(`/api/laps/${representativeLapId}/experiment-excluded`, { data: { excluded: false } });
    }
    await fixture.cleanup();
  }
});
