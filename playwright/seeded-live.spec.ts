import { expect, test, type APIRequestContext, type APIResponse, type Page } from "@playwright/test";
import { z } from "zod";

import { SEEDED_GAME_CASES } from "./seeded-e2e-cases";
import { collectBrowserErrors, metricRowText } from "./seeded-e2e-helpers";

type GameId = (typeof SEEDED_GAME_CASES)[number]["gameId"];

const RECORDING_BY_GAME = {
  "fm-2023": "fm-2023-2026-04-09T21-55-03-186Z",
  "f1-2025": "f1-2025-2026-04-22T11-42-43-029Z",
  acc: "acc-2026-04-23T16-42-16-158Z",
  "ac-evo": "session-ac-evo-mid-2026-04-21T20-24-34-810Z",
  iracing: "iracing-road-america-gt3",
} as const satisfies Record<GameId, string>;

type LiveChannel =
  | { kind: "dynamic"; label: string }
  | { kind: "static"; label: string }
  | { kind: "event"; label: string; states: readonly string[] }
  | {
      kind: "fixture-limited-value";
      label: string;
      expected: string;
      evidence: string;
    }
  | {
      kind: "fixture-limited-event";
      label: string;
      states: readonly string[];
      sourcePacketCount: number;
      evidence: string;
    };

/**
 * Browser-visible channel contract. Dynamic values must move; event channels
 * must expose at least two fixture states; static values only prove presence.
 * Fixture-limited channels retain exact parser evidence instead of inventing a
 * transition absent from committed native capture.
 */
const LIVE_CHANNELS_BY_GAME = {
  "fm-2023": [
    { kind: "dynamic", label: "Current" },
    {
      kind: "fixture-limited-value",
      label: "Est. Lap",
      expected: "--:--.---",
      evidence:
        "committed FM replay has no seeded sector best, so server cannot calculate an estimated lap",
    },
    { kind: "static", label: "Lap" },
  ],
  "f1-2025": [
    { kind: "dynamic", label: "Current" },
    { kind: "dynamic", label: "ERS" },
    {
      kind: "fixture-limited-value",
      label: "Est. Lap",
      expected: "--:--.---",
      evidence:
        "committed F1 replay has no EstimatedLapTime values or seeded sector best, so server cannot calculate an estimated lap",
    },
    { kind: "static", label: "Weather" },
    { kind: "event", label: "DRS state", states: ["DRS", "DRS READY", "DRS OPEN"] },
  ],
  acc: [
    { kind: "dynamic", label: "Current" },
    {
      kind: "fixture-limited-value",
      label: "Est. Lap",
      expected: "--:--.---",
      evidence:
        "committed ACC replay resolves track 2 with no seeded sector best, so estimated lap remains unavailable",
    },
    { kind: "static", label: "Lap" },
    { kind: "event", label: "Pit state", states: ["OUT", "PIT LANE", "IN PIT"] },
  ],
  "ac-evo": [
    { kind: "dynamic", label: "Current" },
    {
      kind: "fixture-limited-value",
      label: "Est. Lap",
      expected: "--:--.---",
      evidence:
        "committed AC Evo replay resolves Brands Hatch GP with no seeded sector best, so estimated lap remains unavailable",
    },
    { kind: "static", label: "Lap" },
    { kind: "event", label: "Pit state", states: ["OUT", "PIT LANE", "IN PIT"] },
  ],
  iracing: [
    { kind: "dynamic", label: "Current" },
    {
      kind: "fixture-limited-value",
      label: "Est. Lap",
      expected: "--:--.---",
      evidence:
        "138-packet iRacing fixture has no seeded sector best, so estimated lap remains unavailable",
    },
    { kind: "static", label: "Lap" },
    {
      kind: "fixture-limited-event",
      label: "iRacing pit state",
      states: ["OUT", "PIT LANE", "IN PIT"],
      sourcePacketCount: 138,
      evidence:
        "iracing-road-america-gt3.bin.gz has 138 packets; iracing.onPitRoad=false in all 138, so no pit entry/exit transition exists to assert",
    },
  ],
} as const satisfies Record<GameId, readonly LiveChannel[]>;

const ReplayResponseSchema = z.object({
  ok: z.literal(true),
  recordingName: z.string(),
  sourcePacketCount: z.number().int().positive(),
  replayedPacketCount: z.number().int().positive(),
});

type ReplayResult = z.infer<typeof ReplayResponseSchema>;

async function assertReplayCompleted(response: APIResponse, recordingName: string): Promise<ReplayResult> {
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
      const inPitVisible =
        (await page.getByText("IN PIT", { exact: true }).isVisible()) ||
        (await page.getByText("PIT LANE", { exact: true }).isVisible());
      if (!inPitVisible) return state;
      continue;
    }
    if (await page.getByText(state, { exact: true }).isVisible()) return state;
  }
  return "unrendered";
}

async function assertRecordingChangesLiveChannels(
  page: Page,
  request: APIRequestContext,
  gameId: GameId,
  recordingName: string,
): Promise<ReplayResult> {
  const channels = LIVE_CHANNELS_BY_GAME[gameId];
  const replayIntervalMs = gameId === "f1-2025" ? 50 : 12;
  const replayResponsePromise = request.post(
    `/api/dev/replay/${recordingName}?packets=240&intervalMs=${replayIntervalMs}`,
    { timeout: 20_000 },
  );
  for (const channel of channels) {
    if (channel.kind === "static") {
      await expect(page.getByText(channel.label, { exact: true }).first(), `${gameId} static ${channel.label}`).toBeVisible({
        timeout: 20_000,
      });
    }
  }
  for (const channel of channels) {
    if (channel.kind !== "fixture-limited-value") continue;
    expect(
      await metricRowText(page, channel.label),
      `${gameId} ${channel.label} fixture evidence: ${channel.evidence}`,
    ).toContain(channel.expected);
  }
  const dynamicChannels = channels.filter((channel) => channel.kind === "dynamic");
  const eventChannels = channels.filter((channel) => channel.kind === "event");
  const dynamicObserved = new Map<string, Set<string>>(
    dynamicChannels.map((channel) => [channel.label, new Set<string>()]),
  );
  const eventObserved = new Map<string, Set<string>>(
    eventChannels.map((channel) => [channel.label, new Set<string>()]),
  );

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
        return (
          dynamicChannels.filter((channel) => dynamicObserved.get(channel.label)!.size > 1).length +
          eventChannels.filter((channel) => eventObserved.get(channel.label)!.size > 1).length
        );
      },
      { timeout: 20_000, intervals: [60, 80, 100] },
    )
    .toBe(expectedSatisfied);

  const result = await assertReplayCompleted(await replayResponsePromise, recordingName);
  for (const channel of channels) {
    if (channel.kind !== "fixture-limited-event") continue;
    expect(result.sourcePacketCount, `${gameId} ${channel.label} fixture evidence: ${channel.evidence}`).toBe(
      channel.sourcePacketCount,
    );
    await expect
      .poll(() => visibleState(page, channel.states), { timeout: 5_000, intervals: [80, 100] })
      .toBe("OUT");
  }
  return result;
}

async function assertRecordingChangesRawValue(
  page: Page,
  request: APIRequestContext,
  recordingName: string,
): Promise<void> {
  const valueRow = page.locator('[data-telemetry-field="CurrentLap"]');
  await expect(valueRow, "raw CurrentLap row").toBeVisible({ timeout: 20_000 });
  const replayResponsePromise = request.post(
    `/api/dev/replay/${recordingName}?packets=240&intervalMs=12`,
  );
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

async function assertDisconnectReconnect(
  page: Page,
  request: APIRequestContext,
  gameId: GameId,
): Promise<void> {
  const recordingName = RECORDING_BY_GAME[gameId];
  const disconnectResponse = await request.post("/api/dev/disconnect");
  expect(disconnectResponse.ok(), `${gameId} disconnect response`).toBe(true);
  const payload = (await disconnectResponse.json()) as { ok: boolean; disconnectedClients: number };
  expect(payload).toMatchObject({ ok: true });
  expect(payload.disconnectedClients, `${gameId} websocket client count`).toBeGreaterThan(0);

  const status = page.getByRole("status").first();
  await expect(status).toHaveAttribute("aria-label", /Disconnected/, { timeout: 10_000 });
  await expect(status).toHaveAttribute("aria-label", /Server/, { timeout: 10_000 });
  await assertRecordingChangesLiveChannels(page, request, gameId, recordingName);
}

test.describe.configure({ mode: "serial" });

for (const game of SEEDED_GAME_CASES) {
  test(`${game.name} live channels and reconnect use committed recording`, async ({ page, request }) => {
    test.setTimeout(75_000);
    const browserErrors = collectBrowserErrors(page);
    const livePath = game.gameId === "iracing" ? "/iracing/live/driver" : `/${game.prefix}/live`;
    await page.goto(livePath, { waitUntil: "domcontentloaded" });
    await assertRecordingChangesLiveChannels(
      page,
      request,
      game.gameId,
      RECORDING_BY_GAME[game.gameId],
    );

    if (game.gameId === "iracing") {
      await expect(page.getByRole("link", { name: "Driver", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "Pit Crew", exact: true }).click();
      await expect(page).toHaveURL(/\/iracing\/live\/pit$/);
      await expect(page.getByText(/Telemetry \(60s\)/)).toBeVisible();
      await expect(page.getByText(/Tires/).first()).toBeVisible();
    }

    await assertDisconnectReconnect(page, request, game.gameId);
    await page.goto(`/${game.prefix}/raw`, { waitUntil: "domcontentloaded" });
    await assertRecordingChangesRawValue(
      page,
      request,
      RECORDING_BY_GAME[game.gameId],
    );
    expect(browserErrors.errors, `unexpected ${game.gameId} live browser errors`).toEqual([]);
  });
}
