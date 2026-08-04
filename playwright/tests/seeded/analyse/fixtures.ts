import { expect, type APIRequestContext, type Page } from "@playwright/test";

import type { LapMeta } from "../../../../shared/racing/sessions/types";
import type { SeededLapTarget } from "../../support/seeded/laps";

export async function gameRows<T>(request: APIRequestContext, resource: "laps" | "sessions", gameId = "fm-2023"): Promise<T[]> {
  const response = await request.get(`/api/${resource}?gameId=${gameId}`);
  expect(response.ok(), `${resource} fixture response`).toBe(true);
  return response.json() as Promise<T[]>;
}

export async function getAlternateSeededLap(request: APIRequestContext, initialLap: SeededLapTarget): Promise<LapMeta> {
  const alternate = (await gameRows<LapMeta>(request, "laps")).find((lap) => lap.id !== initialLap.id && lap.trackOrdinal === initialLap.trackOrdinal && lap.carOrdinal === initialLap.carOrdinal);
  if (!alternate) throw new Error("Missing alternate seeded FM lap");
  return alternate;
}

export async function openAnalyseLap(page: Page, target: Pick<SeededLapTarget, "trackOrdinal" | "carOrdinal" | "id">, prefix = "fm23"): Promise<void> {
  await page.goto(`/${prefix}/analyse?track=${target.trackOrdinal}&car=${target.carOrdinal}&lap=${target.id}`, { waitUntil: "domcontentloaded" });
  await expect(page.getByRole("heading", { name: "Metrics at Cursor" })).toBeVisible({ timeout: 30_000 });
}

export async function findNoTelemetryLap(request: APIRequestContext): Promise<LapMeta | undefined> {
  const rows = await gameRows<LapMeta>(request, "laps");
  for (const row of rows.filter((candidate) => !candidate.isValid)) {
    const response = await request.get(`/api/laps/${row.id}`, {
      headers: { "X-Game-Id": "fm-2023" },
    });
    if (!response.ok()) continue;
    const payload = (await response.json()) as {
      telemetry?: unknown[];
      parseError?: string;
    };
    if (!payload.parseError && payload.telemetry?.length === 0) {
      return row;
    }
  }
  return undefined;
}
