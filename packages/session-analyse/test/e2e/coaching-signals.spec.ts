import { expect, test } from "@playwright/test";
import { decodeAlignedLapSet } from "@raceiq/analysis-core/racing/laps/alignment/codec";
import { ThreeToImproveResponseSchema } from "../../contracts";
import { COACHING_FRAME_COUNT, importCoachingRecording } from "./coaching-fixtures";

const EXPECTED_PRIORITY = [
  { family: "brake-drag", id: "brake-drag:8" },
  { family: "downshift", id: "downshift:17" },
  { family: "steering", id: "steering:30" },
] as const;
test("zero, one and two actionable signals remain honest, with single-lap labels", async ({ page, request }) => {
  const cases = [
    { label: "coaching-zero", signals: [] as const, families: [] as string[], state: "no-actionable-findings" },
    { label: "coaching-one", signals: ["brake-drag"] as const, families: ["brake-drag"], state: "ready" },
    { label: "coaching-two", signals: ["brake-drag", "downshift"] as const, families: ["brake-drag", "downshift"], state: "ready" },
  ] as const;
  for (const scenario of cases) {
    const fixture = await importCoachingRecording(request, {
      label: `${scenario.label}-${Date.now()}`,
      lapCount: 1,
      signals: scenario.signals,
    });
    try {
      const response = await request.get(`/api/sessions/${fixture.sessionId}/3-to-improve`, {
        headers: { "X-Game-Id": "iracing" },
      });
      expect(response.status()).toBe(200);
      const summary = ThreeToImproveResponseSchema.parse(await response.json());
      expect(summary.state).toBe(scenario.state);
      expect(summary.eligibleLapCount).toBe(1);
      expect(summary.analyzedLapCount).toBe(1);
      expect(summary.items.map(({ family }) => family)).toEqual(scenario.families);
      expect(summary.items.every(({ evidenceLevel, supportingLapCount }) =>
        evidenceLevel === "single-lap" && supportingLapCount === 1,
      )).toBe(true);
      if (scenario.families.length === 0) {
        await page.goto(`/iracing/sessions/${fixture.sessionId}/analyse`, { waitUntil: "domcontentloaded" });
        const section = page.getByTestId("three-to-improve");
        await expect(section).toBeVisible();
        await expect(section.getByText(/No actionable patterns found in this session/)).toBeVisible();
        await expect(section.locator("[data-coaching-family]")).toHaveCount(0);
      }
    } finally {
      await fixture.cleanup();
    }
  }
});

test("real recording signal evidence ranks whole-session priorities and opens dismissible evidence", async ({ page, request }) => {
  const fixture = await importCoachingRecording(request, { label: `coaching-priority-${Date.now()}` });
  try {
    const response = await request.get(`/api/sessions/${fixture.sessionId}/3-to-improve`, {
      headers: { "X-Game-Id": "iracing" },
    });
    expect(response.status()).toBe(200);
    const summary = ThreeToImproveResponseSchema.parse(await response.json());
    expect(summary.state).toBe("ready");
    expect(summary.eligibleLapCount).toBe(3);
    expect(summary.analyzedLapCount).toBe(3);
    expect(summary.items.map(({ family, id }) => ({ family, id }))).toEqual(EXPECTED_PRIORITY);
    expect(summary.items.map(({ supportingLapCount, evidencePointCount, evidenceLevel }) => ({
      supportingLapCount,
      evidencePointCount,
      evidenceLevel,
    }))).toEqual(EXPECTED_PRIORITY.map(() => ({ supportingLapCount: 3, evidencePointCount: 3, evidenceLevel: "repeated" })));
    const expectedFrameIndices = [105, 210, 362];
    expect(summary.items.map(({ representative }) => representative.sourceFrameIndex)).toEqual(expectedFrameIndices);
    for (const [index, item] of summary.items.entries()) {
      expect(item.location.fraction).toBeCloseTo(expectedFrameIndices[index]! / (COACHING_FRAME_COUNT - 1), 12);
      expect(item.representative.lapNumber).toBe(1);
    }
    const brakePriority = summary.items[0]!;
    const evidenceResponse = await request.get(
      `/api/sessions/${fixture.sessionId}/3-to-improve/evidence?lapId=${brakePriority.representative.lapId}&sourceFrameIndex=${brakePriority.representative.sourceFrameIndex}`,
      { headers: { "X-Game-Id": "iracing" } },
    );
    expect(evidenceResponse.status()).toBe(200);
    const detail = await evidenceResponse.json() as {
      sessionId: number;
      gameId: string;
      representative: { lapId: number; lapNumber: number; sourceFrameIndex: number };
      fraction: number;
      aligned: Parameters<typeof decodeAlignedLapSet>[0];
    };
    expect(detail.sessionId).toBe(fixture.sessionId);
    expect(detail.gameId).toBe("iracing");
    expect(detail.representative).toEqual(brakePriority.representative);
    expect(detail.fraction).toBe(brakePriority.location.fraction);
    const aligned = decodeAlignedLapSet(detail.aligned);
    expect(aligned.laps).toHaveLength(1);
    expect(aligned.laps[0]!.lapId).toBe(brakePriority.representative.lapId);
    expect(aligned.laps[0]!.speedMps.some((speed) => Math.abs(speed - 4_000 / 60) < 0.01)).toBe(true);
    expect(aligned.laps[0]!.throttle.some((throttle) => throttle > 0.85)).toBe(true);
    expect(aligned.laps[0]!.brake.some((brake) => brake > 0.09 && brake < 0.11)).toBe(true);

    const lapResponse = await request.get("/api/laps?gameId=iracing");
    expect(lapResponse.ok()).toBe(true);
    const sessionLaps = (await lapResponse.json() as Array<{ id: number; sessionId: number; lapNumber: number }>)
      .filter((lap) => lap.sessionId === fixture.sessionId)
      .sort((a, b) => a.lapNumber - b.lapNumber);
    expect(sessionLaps).toHaveLength(3);
    const [firstLap, secondLap, thirdLap] = sessionLaps as [typeof sessionLaps[number], typeof sessionLaps[number], typeof sessionLaps[number]];
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/iracing/sessions/${fixture.sessionId}/analyse?laps=${firstLap.id},${secondLap.id}&primary=${firstLap.id}`, { waitUntil: "domcontentloaded" });
    const section = page.getByTestId("three-to-improve");
    await expect(section).toBeVisible();
    const cards = section.locator("[data-coaching-family]");
    await expect(cards).toHaveCount(3);
    for (let index = 0; index < EXPECTED_PRIORITY.length; index++) {
      await expect(cards.nth(index)).toHaveAttribute("data-coaching-family", EXPECTED_PRIORITY[index]!.family);
    }
    const selectionButton = page.getByRole("button", { name: /^Laps:/ });
    await selectionButton.click();
    const dialog = page.getByRole("dialog", { name: "Choose laps to display" });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("checkbox", { name: `Display Lap ${firstLap.lapNumber}` }).uncheck();
    await dialog.getByRole("checkbox", { name: `Display Lap ${thirdLap.lapNumber}` }).check();
    await dialog.getByRole("radio", { name: `Primary Lap ${secondLap.lapNumber}` }).check();
    await dialog.getByRole("button", { name: "Apply", exact: true }).click();
    for (let index = 0; index < EXPECTED_PRIORITY.length; index++) {
      await expect(cards.nth(index)).toHaveAttribute("data-coaching-family", EXPECTED_PRIORITY[index]!.family);
    }
    await expect(cards).toHaveCount(3);
    const selectionUrl = new URL(page.url());
    expect(selectionUrl.searchParams.get("laps")?.split(",").sort()).toEqual([String(secondLap.id), String(thirdLap.id)].sort());
    expect(selectionUrl.searchParams.get("primary")).toBe(String(secondLap.id));
    const evidenceButton = cards.first().getByRole("button", { name: /evidence/i });
    await evidenceButton.focus();
    await evidenceButton.press("Enter");
    const evidence = page.getByTestId("three-to-improve-evidence");
    await expect(evidence).toBeVisible();
    await expect(evidence.getByRole("heading", { name: `Lap ${detail.representative.lapNumber}`, exact: true })).toBeVisible();
    await evidence.getByRole("button", { name: /close/i }).focus();
    await page.keyboard.press("Escape");
    await expect(evidence).toHaveCount(0);
    await expect(evidenceButton).toBeFocused();
    expect(new URL(page.url()).pathname).toBe(`/iracing/sessions/${fixture.sessionId}/analyse`);
    expect(page.url()).toBe(selectionUrl.href);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(section).toBeVisible();
    expect(await section.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(section.locator("[data-coaching-family]")).toHaveCount(3);
  } finally {
    await fixture.cleanup();
  }
});
