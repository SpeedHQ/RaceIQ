import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { SEEDED_GAME_CASES, type SeededGame } from "../../support/seeded/cases";
import { collectBrowserErrors } from "../../support/browser-errors";
import type { GameId } from "../../../../shared/games/ids";
import type { TelemetryGameLink } from "../../../../shared/telemetry/catalog/contracts";
import { TELEMETRY_CATALOG } from "../../../../shared/telemetry/catalog/data";
import type { TelemetryPacket } from "../../../../shared/telemetry/types";

const RECORDING_BY_GAME: Record<GameId, string> = {
  "fm-2023": "fm-2023-2026-04-09T21-55-03-186Z",
  "f1-2025": "f1-2025-2026-04-22T11-42-43-029Z",
  acc: "acc-2026-04-23T16-42-16-158Z",
  "ac-evo": "session-ac-evo-mid-2026-04-21T20-24-34-810Z",
  iracing: "iracing-daytona-am-vantage-gt3-pit",
};
const CATEGORY_BY_FRESHNESS = { continuous: "dynamic", static: "static", "session-update": "event", "pit-snapshot": "event" } as const;
type CatalogField = { readonly field: keyof TelemetryPacket; readonly expectedCategory?: "dynamic" | "static" | "event" | "unsupported" };
const CATALOG_FIELDS: readonly CatalogField[] = [
  { field: "Speed", expectedCategory: "dynamic" },
  { field: "CurrentLap", expectedCategory: "dynamic" },
  { field: "DrsActive" },
  { field: "HandBrake" },
  { field: "NumCylinders" },
  { field: "TireTempFL" },
];
function categoryForLink(link: TelemetryGameLink): "dynamic" | "static" | "event" | "unsupported" {
  return link.kind === "unavailable" ? "unsupported" : CATEGORY_BY_FRESHNESS[link.freshness];
}
function catalogForField(gameId: GameId, field: keyof TelemetryPacket) {
  const variable = TELEMETRY_CATALOG.variables.find((candidate) => candidate.packetFields?.includes(field));
  expect(variable, `${gameId} ${field} must exist in authoritative telemetry catalog`).toBeDefined();
  return { variable: variable!, link: variable!.games[gameId] };
}
function fieldRow(page: Page, field: string) {
  return page.locator(`[data-telemetry-field="${field}"]`);
}
async function replayRawRecording(page: Page, request: APIRequestContext, game: SeededGame): Promise<void> {
  await expect(page.locator("[data-telemetry-raw='true']")).toBeVisible();
  const replayResponsePromise = request.post(`/api/dev/replay/${RECORDING_BY_GAME[game.gameId]}?packets=240&intervalMs=12`);
  const row = fieldRow(page, "CurrentLap");
  const value = row.locator("span.font-mono");
  await expect(value, `${game.name} CurrentLap value`).toBeVisible();
  const response = await replayResponsePromise;
  expect(response.ok(), `${game.name} raw replay response`).toBe(true);
  const payload = (await response.json()) as { ok: boolean; recordingName: string; replayedPacketCount: number };
  expect(payload.ok, `${game.name} replay completed`).toBe(true);
  expect(payload.recordingName, `${game.name} recording provenance`).toBe(RECORDING_BY_GAME[game.gameId]);
  expect(payload.replayedPacketCount, `${game.name} replay packet count`).toBeGreaterThan(1);
}
async function assertCatalogField(page: Page, game: SeededGame, fieldCase: CatalogField): Promise<void> {
  const { variable, link } = catalogForField(game.gameId, fieldCase.field);
  const expectedCategory = categoryForLink(link);
  if (fieldCase.expectedCategory) expect(expectedCategory, `${game.name} ${fieldCase.field} catalog category`).toBe(fieldCase.expectedCategory);
  const row = fieldRow(page, fieldCase.field);
  await expect(row, `${game.name} ${fieldCase.field} catalog row`).toHaveCount(1);
  await expect(row, `${game.name} ${fieldCase.field} category`).toHaveAttribute("data-telemetry-category", expectedCategory);
  await expect(row, `${game.name} ${fieldCase.field} canonical unit`).toHaveAttribute("data-telemetry-unit", variable.canonicalUnit);
  if (link.kind === "unavailable") {
    await expect(row, `${game.name} ${fieldCase.field} unsupported presentation`).toContainText("Unavailable");
    await expect(row, `${game.name} ${fieldCase.field} unsupported provenance`).toHaveAttribute("data-telemetry-provenance", `unavailable:${link.reason}`);
    return;
  }
  await expect(row, `${game.name} ${fieldCase.field} provenance origin/artifact/commit`).toHaveAttribute(
    "data-telemetry-provenance",
    `${link.provenance.origin}:${link.provenance.artifact}@${link.provenance.commit}`,
  );
}

test.describe.configure({ mode: "serial" });
for (const game of SEEDED_GAME_CASES) {
  test(`${game.name} raw telemetry presents catalog metadata`, async ({ page, request }) => {
    test.setTimeout(90_000);
    const browserErrors = collectBrowserErrors(page);
    await page.goto(`/${game.prefix}/raw`, { waitUntil: "domcontentloaded" });
    await replayRawRecording(page, request, game);
    for (const fieldCase of CATALOG_FIELDS) {
      const { link } = catalogForField(game.gameId, fieldCase.field);
      if (
        link.kind === "unavailable" ||
        fieldCase.field === "Speed" ||
        fieldCase.field === "CurrentLap" ||
        (game.gameId === "f1-2025" && fieldCase.field === "NumCylinders") ||
        (game.gameId === "iracing" && fieldCase.field === "TireTempFL")
      ) {
        await test.step(`${game.name} ${fieldCase.field} catalog category/unit/provenance`, async () => {
          await assertCatalogField(page, game, fieldCase);
        });
      }
    }
    expect(browserErrors.errors, `unexpected ${game.name} raw browser errors`).toEqual([]);
  });
}
