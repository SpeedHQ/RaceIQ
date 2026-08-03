import { expect, type APIRequestContext, type Page } from "@playwright/test";
import type { GameId } from "../shared/games/ids";
import type { TelemetryPacket } from "../shared/telemetry/types";

interface SeededLapListItem {
  id: number;
  lapNumber: number;
  lapTime: number;
  carOrdinal: number;
  trackOrdinal: number;
  isValid: boolean;
}

export interface SeededLapTarget extends SeededLapListItem {
  telemetry: TelemetryPacket[];
}

export interface BrowserErrorCollector {
  readonly errors: string[];
}

const IGNORED_BROWSER_ERRORS = [/THREE\.GLTFLoader: Couldn't load texture/];

export function collectBrowserErrors(page: Page): BrowserErrorCollector {
  const errors: string[] = [];
  const record = (message: string) => {
    if (!IGNORED_BROWSER_ERRORS.some((pattern) => pattern.test(message))) {
      errors.push(message);
    }
  };
  page.on("pageerror", (error) => record(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") record(`console.error: ${message.text()}`);
  });
  page.on("response", (response) => {
    if (response.status() >= 400) {
      record(`http ${response.status()}: ${response.url()}`);
    }
  });
  return { errors };
}

export async function getSeededLapTarget(
  request: APIRequestContext,
  gameId: GameId,
): Promise<SeededLapTarget> {
  const listResponse = await request.get(`/api/laps?gameId=${gameId}`);
  expect(listResponse.ok(), `${gameId} seeded lap list`).toBe(true);

  const laps = (await listResponse.json()) as SeededLapListItem[];
  const selected = laps.find((lap) => lap.isValid);
  expect(selected, `${gameId} needs one valid seeded lap`).toBeDefined();

  const telemetryResponse = await request.get(`/api/laps/${selected!.id}`, {
    headers: { "X-Game-Id": gameId },
  });
  expect(telemetryResponse.ok(), `${gameId} seeded lap telemetry`).toBe(true);

  const payload = (await telemetryResponse.json()) as {
    telemetry?: TelemetryPacket[];
  };
  expect(payload.telemetry?.length, `${gameId} seeded lap packet count`).toBeGreaterThan(10);

  return { ...selected!, telemetry: payload.telemetry! };
}

export async function setAnalyseFrame(page: Page, frame: number): Promise<void> {
  await page.evaluate((index) => {
    const setFrame = (window as typeof window & { __setFrame?: (value: number) => void }).__setFrame;
    if (!setFrame) throw new Error("Analyse frame control is unavailable");
    setFrame(index);
  }, frame);
  await expect(page.getByRole("slider", { name: "Lap timeline" })).toHaveAttribute(
    "aria-valuenow",
    String(frame),
  );
}

export async function metricRowText(page: Page, label: string): Promise<string> {
  const labelNode = page.getByText(label, { exact: true }).last();
  await expect(labelNode, `${label} metric label`).toBeVisible();
  return labelNode.locator("..").innerText();
}
