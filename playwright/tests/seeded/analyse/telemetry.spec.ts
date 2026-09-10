import { expect, test } from "@playwright/test";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";
import { SEEDED_GAME_CASES } from "../../support/seeded/cases";
import { collectBrowserErrors } from "../../support/browser-errors";
import { getSeededLapTarget } from "../../support/seeded/laps";
import { metricRowText, setAnalyseFrame } from "../../support/seeded/analyse";

const COMMON_DYNAMIC_FIELDS = [
  { label: "Speed", sourceField: "Speed", minimumRange: 1 },
  { label: "RPM", sourceField: "CurrentEngineRpm", minimumRange: 50 },
  { label: "Gear", sourceField: "Gear", minimumRange: 0 },
  { label: "Throttle", sourceField: "Accel", minimumRange: 5 },
  { label: "Brake", sourceField: "Brake", minimumRange: 5 },
  { label: "Steer", sourceField: "Steer", minimumRange: 2 },
] as const satisfies readonly { label: string; sourceField: keyof TelemetryPacket; minimumRange: number }[];
const GAME_METRIC_ROWS = {
  "fm-2023": [{ label: "Grip Ask", sourceField: "TireCombinedSlipFL" }],
  "f1-2025": [{ label: "Grip Ask", sourceField: "TireCombinedSlipFL" }, { label: "Angle", sourceField: "TireSlipAngleFL" }, { label: "Travel", sourceField: "SuspensionTravelMFL" }],
  acc: [{ label: "Grip Ask", sourceField: "TireCombinedSlipFL" }, { label: "Angle", sourceField: "TireSlipAngleFL" }, { label: "Travel", sourceField: "SuspensionTravelMFL" }],
  "ac-evo": [{ label: "Grip Ask", sourceField: "TireCombinedSlipFL", vary: false }, { label: "Angle", sourceField: "TireSlipAngleFL" }, { label: "Travel", sourceField: "SuspensionTravelMFL" }],
  iracing: [{ label: "Travel", sourceField: "SuspensionTravelMFL", vary: false }],
} as const satisfies Record<string, readonly { label: string; sourceField: keyof TelemetryPacket; vary?: boolean }[]>;

interface FieldExtremes {
  readonly minimum: number;
  readonly maximum: number;
  readonly minimumFrame: number;
  readonly maximumFrame: number;
}

function findFieldExtremes(telemetry: readonly TelemetryPacket[], sourceField: keyof TelemetryPacket): FieldExtremes {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  let minimumFrame = -1;
  let maximumFrame = -1;
  for (const [frame, packet] of telemetry.entries()) {
    const value = packet[sourceField];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    if (value < minimum) {
      minimum = value;
      minimumFrame = frame;
    }
    if (value > maximum) {
      maximum = value;
      maximumFrame = frame;
    }
  }
  return { minimum, maximum, minimumFrame, maximumFrame };
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  const settingsResponse = await page.request.get("/api/settings");
  expect(settingsResponse.ok()).toBe(true);
  const settings = await settingsResponse.json();
  if (!settings.onboardingComplete) {
    const updateResponse = await page.request.put("/api/settings", { data: { ...settings, onboardingComplete: true } });
    expect(updateResponse.ok()).toBe(true);
  }
  await page.addInitScript(() => {
    (window as unknown as Record<string, unknown>).__recording = true;
  });
});

for (const game of SEEDED_GAME_CASES) {
  test(`${game.name} Analyse renders changing values over one seeded lap`, async ({ page, request }) => {
    test.setTimeout(120_000);
    const browserErrors = collectBrowserErrors(page);
    const lap = await getSeededLapTarget(request, game.gameId);
    const query = new URLSearchParams({ track: String(lap.trackOrdinal), car: String(lap.carOrdinal), lap: String(lap.id) });

    await page.goto(`/${game.prefix}/analyse?${query}`, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => page.evaluate(() => Number((window as unknown as Record<string, unknown>).__totalFrames ?? 0)), { timeout: 30_000 }).toBe(lap.telemetry.length);

    const representativeFrames = [0, Math.floor(lap.telemetry.length / 2), lap.telemetry.length - 1];
    for (const frame of representativeFrames) {
      await setAnalyseFrame(page, frame);
      await expect(page.getByText(`Packet ${frame + 1}/${lap.telemetry.length}`, { exact: true })).toBeVisible();
    }

    for (const field of COMMON_DYNAMIC_FIELDS) {
      await test.step(`${field.label} follows changing ${field.sourceField}`, async () => {
        const extremes = findFieldExtremes(lap.telemetry, field.sourceField);
        expect(extremes.minimumFrame, `${game.gameId} lap ${lap.id} ${field.sourceField} minimum frame`).toBeGreaterThanOrEqual(0);
        expect(extremes.maximumFrame, `${game.gameId} lap ${lap.id} ${field.sourceField} maximum frame`).toBeGreaterThanOrEqual(0);
        expect(extremes.maximum - extremes.minimum, `${game.gameId} lap ${lap.id} ${field.sourceField} source range`).toBeGreaterThan(field.minimumRange);
        await setAnalyseFrame(page, extremes.minimumFrame);
        const minimumText = await metricRowText(page, field.label);
        await setAnalyseFrame(page, extremes.maximumFrame);
        const maximumText = await metricRowText(page, field.label);
        expect(maximumText, `${game.gameId} lap ${lap.id} ${field.label} must change when source telemetry changes`).not.toBe(minimumText);
      });
    }
    for (const row of GAME_METRIC_ROWS[game.gameId]) {
      await test.step(`${row.label} follows bound source`, async () => {
        const extremes = findFieldExtremes(lap.telemetry, row.sourceField);
        expect(extremes.minimumFrame, `${game.gameId} ${row.label} source minimum`).toBeGreaterThanOrEqual(0);
        expect(extremes.maximumFrame, `${game.gameId} ${row.label} source maximum`).toBeGreaterThanOrEqual(0);
        await setAnalyseFrame(page, extremes.minimumFrame);
        const minimumText = await metricRowText(page, row.label);
        await setAnalyseFrame(page, extremes.maximumFrame);
        const maximumText = await metricRowText(page, row.label);
        expect(minimumText).not.toContain("—");
        expect(maximumText).not.toContain("—");
        if (row.vary !== false) expect(maximumText).not.toBe(minimumText);
      });
    }

    const parityFrame = Math.floor(lap.telemetry.length / 2);
    await setAnalyseFrame(page, parityFrame);
    const parityPacket = lap.telemetry[parityFrame]!;
    if (game.gameId === "acc") {
      expect(typeof parityPacket.acc?.brakeBias, "seeded ACC brake bias source").toBe("number");
      expect(await metricRowText(page, "Brake Bias")).toContain(`${(parityPacket.acc!.brakeBias * 100).toFixed(1)}%F`);
    }
    if (game.gameId === "f1-2025") {
      const ersModes = ["None", "Low", "Medium", "High", "Overtake"] as const;
      expect(await metricRowText(page, "ERS Store")).toContain(`${(((parityPacket.ErsStoreEnergy ?? 0) / 4_000_000) * 100).toFixed(1)}%`);
      expect(await metricRowText(page, "Deployed")).toContain(`${(((parityPacket.ErsDeployed ?? 0) / 4_000_000) * 100).toFixed(1)}%`);
      expect(await metricRowText(page, "Harvested")).toContain(`${(((parityPacket.ErsHarvested ?? 0) / 4_000_000) * 100).toFixed(1)}%`);
      expect(await metricRowText(page, "Mode")).toContain(ersModes[parityPacket.ErsDeployMode ?? 0] ?? "Unknown");
      expect(await metricRowText(page, "Fuel")).toContain(
        `${((lap.telemetry[0]!.Fuel - parityPacket.Fuel) * 100).toFixed(1)}% used ${(parityPacket.Fuel * 100).toFixed(1)}% left`,
      );
    }
    expect(browserErrors.errors, `${game.gameId} Analyse browser errors`).toEqual([]);
  });
}
