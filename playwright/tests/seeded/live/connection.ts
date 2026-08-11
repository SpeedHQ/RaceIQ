import { expect, type APIRequestContext, type Page } from "@playwright/test";

import { RECORDING_BY_GAME } from "./fixtures";
import { assertRecordingChangesLiveChannels } from "./replay";

export async function assertDisconnectReconnect(page: Page, request: APIRequestContext, gameId: keyof typeof RECORDING_BY_GAME): Promise<void> {
  const recordingName = RECORDING_BY_GAME[gameId];
  const disconnectResponse = await request.post("/api/dev/disconnect");
  expect(disconnectResponse.ok(), `${gameId} disconnect response`).toBe(true);
  const payload = (await disconnectResponse.json()) as { ok: boolean; disconnectedClients: number };
  expect(payload).toMatchObject({ ok: true });
  expect(payload.disconnectedClients, `${gameId} websocket client count`).toBeGreaterThan(0);

  const status = page.getByRole("status").first();
  await expect(status).toHaveAttribute("aria-label", /Disconnected/, { timeout: 10_000 });
  await expect(status).toHaveAttribute("aria-label", /Server/, { timeout: 10_000 });
  if (gameId === "iracing" && page.url().endsWith("/iracing/live/pit")) {
    await page.getByRole("link", { name: "Driver", exact: true }).click();
    await expect(page).toHaveURL(/\/iracing\/live\/driver$/);
  }
  await assertRecordingChangesLiveChannels(page, request, gameId, recordingName);
}
