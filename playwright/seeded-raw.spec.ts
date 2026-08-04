import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import {
  SEEDED_GAME_CASES,
  type SeededGame,
} from "./seeded-e2e-cases";
import { collectBrowserErrors } from "./seeded-e2e-helpers";
import type { GameId } from "../shared/games/ids";
import type { TelemetryGameLink } from "../shared/telemetry/catalog/contracts";
import { TELEMETRY_CATALOG } from "../shared/telemetry/catalog/data";

const RECORDING_BY_GAME: Record<GameId, string> = {
  "fm-2023": "fm-2023-2026-04-09T21-55-03-186Z",
  "f1-2025": "f1-2025-2026-04-22T11-42-43-029Z",
  acc: "acc-2026-04-23T16-42-16-158Z",
  "ac-evo": "session-ac-evo-mid-2026-04-21T20-24-34-810Z",
  iracing: "iracing-daytona-am-vantage-gt3-pit",
};

const CATEGORY_BY_FRESHNESS = {
  continuous: "dynamic",
  static: "static",
  "session-update": "event",
  "pit-snapshot": "event",
} as const;

type CatalogField = {
  readonly field: string;
  readonly expectedCategory?: "dynamic" | "static" | "event" | "unsupported";
};

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

function catalogForField(gameId: GameId, field: string) {
  const variable = TELEMETRY_CATALOG.variables.find((candidate) => candidate.packetFields?.includes(field));
  expect(variable, `${gameId} ${field} must exist in authoritative telemetry catalog`).toBeDefined();
  return { variable: variable!, link: variable!.games[gameId] };
}

function fieldRow(page: Page, field: string) {
  return page.locator(`[data-telemetry-field="${field}"]`);
}

async function replayRawRecording(page: Page, request: APIRequestContext, game: SeededGame): Promise<void> {
  const replayResponsePromise = request.post(
    `/api/dev/replay/${RECORDING_BY_GAME[game.gameId]}?packets=240&intervalMs=12`,
  );
  const row = fieldRow(page, "CurrentLap");
  await expect(row, `${game.name} CurrentLap raw row`).toBeVisible({ timeout: 20_000 });
  const value = row.locator("span.font-mono");
  const observed = new Set<string>();
  await expect
    .poll(
      async () => {
        observed.add(await value.innerText());
        return observed.size;
      },
      { timeout: 20_000, intervals: [60, 80, 100] },
    )
    .toBeGreaterThan(1);
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
  if (fieldCase.expectedCategory) {
    expect(expectedCategory, `${game.name} ${fieldCase.field} catalog category`).toBe(fieldCase.expectedCategory);
  }
  const row = fieldRow(page, fieldCase.field);
  await expect(row, `${game.name} ${fieldCase.field} catalog row`).toHaveCount(1);
  await expect(row, `${game.name} ${fieldCase.field} category`).toHaveAttribute(
    "data-telemetry-category",
    expectedCategory,
  );
  await expect(row, `${game.name} ${fieldCase.field} canonical unit`).toHaveAttribute(
    "data-telemetry-unit",
    variable.canonicalUnit,
  );
  if (link.kind === "unavailable") {
    await expect(row, `${game.name} ${fieldCase.field} unsupported presentation`).toContainText("Unavailable");
    await expect(row, `${game.name} ${fieldCase.field} unsupported provenance`).toHaveAttribute(
      "data-telemetry-provenance",
      `unavailable:${link.reason}`,
    );
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

test("Assetto Corsa EVO raw exposes parsed, fields, verify, hex, and data tabs", async ({ page }) => {
  test.setTimeout(45_000);
  const browserErrors = collectBrowserErrors(page);
  await page.goto("/ac-evo/raw", { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("button", { name: /parsed packet/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /struct fields/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /verify/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /raw hex/i })).toBeVisible();

  await page.getByRole("button", { name: /struct fields/i }).click();
  await expect(page.getByText(/Page sizes:|Error:/)).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: /verify/i }).click();
  await expect(page.getByText(/Every field:|Error:/)).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: /raw hex/i }).click();
  for (const dataPage of ["physics", "graphics", "staticData"]) {
    await expect(page.getByRole("button", { name: dataPage, exact: true })).toBeVisible();
    await page.getByRole("button", { name: dataPage, exact: true }).click();
  }
  const nativeUnavailableConsole =
    "console.error: Failed to load resource: the server responded with a status of 503 (Service Unavailable)";
  expect(
    browserErrors.errors.filter((error) => error === nativeUnavailableConsole),
    "each native AC Evo debug endpoint reports its expected 503",
  ).toHaveLength(3);
  const unexpectedErrors = browserErrors.errors.filter(
    (error) =>
      error !== nativeUnavailableConsole &&
      !/^http 503: .*\/api\/ac-evo\/debug\/(raw|verify|hex)$/.test(error),
  );
  expect(unexpectedErrors, "unexpected AC Evo raw browser errors").toEqual([]);

  await page.getByRole("button", { name: /parsed packet/i }).click();
  await expect(page.getByText(/All Telemetry Values|Waiting for telemetry data/)).toBeVisible();
});
