import { expect, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { z } from "zod";

import { metricRowText } from "../../support/seeded/analyse";
import { LIVE_CHANNELS_BY_GAME, type LiveChannel } from "./fixtures";
import type { ReplayResult } from "./types";

const ReplayResponseSchema = z.object({
  ok: z.literal(true),
  recordingName: z.string(),
  sourcePacketCount: z.number().int().positive(),
  replayedPacketCount: z.number().int().positive(),
});

export async function assertReplayCompleted(response: APIResponse, recordingName: string): Promise<ReplayResult> {
  expect(response.ok(), `${recordingName} replay response`).toBe(true);
  const result = ReplayResponseSchema.parse(await response.json());
  expect(result.recordingName).toBe(recordingName);
  expect(result.replayedPacketCount).toBeGreaterThan(1);
  expect(result.replayedPacketCount).toBeLessThanOrEqual(240);
  return result;
}

async function visibleState(page: Page, states: readonly string[]): Promise<string> {
  for (const state of states) {
    if (state === "OUT") {
      const inPitVisible = (await page.getByText("IN PIT", { exact: true }).isVisible()) || (await page.getByText("PIT LANE", { exact: true }).isVisible());
      if (!inPitVisible) return state;
      continue;
    }
    if (await page.getByText(state, { exact: true }).isVisible()) return state;
  }
  return "unrendered";
}

export async function assertRecordingChangesLiveChannels(page: Page, request: APIRequestContext, gameId: keyof typeof LIVE_CHANNELS_BY_GAME, recordingName: string): Promise<ReplayResult> {
  const channels: readonly LiveChannel[] = LIVE_CHANNELS_BY_GAME[gameId];
  const replayIntervalMs = gameId === "f1-2025" ? 50 : 12;
  const replayResponsePromise = request.post(`/api/dev/replay/${recordingName}?packets=240&intervalMs=${replayIntervalMs}`, { timeout: 20_000 });
  for (const channel of channels) {
    if (channel.kind === "static") {
      await expect(page.getByText(channel.label, { exact: true }).first(), `${gameId} static ${channel.label}`).toBeVisible({
        timeout: 20_000,
      });
    }
  }
  for (const channel of channels) {
    if (channel.kind !== "fixture-limited-value") continue;
    expect(await metricRowText(page, channel.label), `${gameId} ${channel.label} fixture evidence: ${channel.evidence}`).toContain(channel.expected);
  }
  const dynamicChannels = channels.filter((channel) => channel.kind === "dynamic");
  const eventChannels = channels.filter((channel) => channel.kind === "event");
  const dynamicObserved = new Map<string, Set<string>>(dynamicChannels.map((channel) => [channel.label, new Set<string>()]));
  const eventObserved = new Map<string, Set<string>>(eventChannels.map((channel) => [channel.label, new Set<string>()]));

  const expectedSatisfied = dynamicChannels.length + eventChannels.length;
  await expect
    .poll(
      async () => {
        for (const channel of dynamicChannels) {
          dynamicObserved.get(channel.label)!.add(await metricRowText(page, channel.label));
        }
        for (const channel of eventChannels) {
          eventObserved.get(channel.label)!.add(await visibleState(page, channel.states));
        }
        return dynamicChannels.filter((channel) => dynamicObserved.get(channel.label)!.size > 1).length + eventChannels.filter((channel) => eventObserved.get(channel.label)!.size > 1).length;
      },
      { timeout: 20_000, intervals: [60, 80, 100] },
    )
    .toBe(expectedSatisfied);

  const result = await assertReplayCompleted(await replayResponsePromise, recordingName);
  return result;
}

export async function assertRecordingChangesRawValue(page: Page, request: APIRequestContext, recordingName: string): Promise<void> {
  const valueRow = page.locator('[data-telemetry-field="CurrentLap"]');
  await expect(valueRow, "raw CurrentLap row").toBeVisible({ timeout: 20_000 });
  const replayResponsePromise = request.post(`/api/dev/replay/${recordingName}?packets=240&intervalMs=12`);
  const observed = new Set<string>();
  await expect
    .poll(
      async () => {
        observed.add(await valueRow.locator("span.font-mono").innerText());
        return observed.size;
      },
      { timeout: 20_000, intervals: [60, 80, 100] },
    )
    .toBeGreaterThan(1);
  await assertReplayCompleted(await replayResponsePromise, recordingName);
}
