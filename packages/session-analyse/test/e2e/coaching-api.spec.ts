import { expect, test } from "@playwright/test";
import { ThreeToImproveResponseSchema } from "../../contracts";
import { importCoachingRecording } from "./coaching-fixtures";

const SUMMARY = (sessionId: number | string) => `/api/sessions/${sessionId}/3-to-improve`;

test("3-to-improve HTTP validates IDs and game scope, then returns stable real session summary", async ({ request }) => {
  const fixture = await importCoachingRecording(request, { label: `coaching-http-${Date.now()}`, lapCount: 1, signals: [] });
  try {
    for (const path of ["not-a-number", "0", "9007199254740992"]) {
      const malformed = await request.get(SUMMARY(path), { headers: { "X-Game-Id": "iracing" } });
      expect(malformed.status(), `invalid session id ${path}`).toBe(400);
    }

    expect((await request.get(SUMMARY(fixture.sessionId))).status()).toBe(400);
    expect((await request.get(SUMMARY(fixture.sessionId), { headers: { "X-Game-Id": "invalid-game" } })).status()).toBe(400);
    expect((await request.get(SUMMARY(999999999), { headers: { "X-Game-Id": "iracing" } })).status()).toBe(404);
    expect((await request.get(SUMMARY(fixture.sessionId), { headers: { "X-Game-Id": "acc" } })).status()).toBe(404);
    expect((await request.get(`/api/sessions/${fixture.sessionId}/3-to-improve/evidence`, {
      headers: { "X-Game-Id": "iracing" },
    })).status()).toBe(400);

    const first = await request.get(SUMMARY(fixture.sessionId), { headers: { "X-Game-Id": "iracing" } });
    expect(first.status()).toBe(200);
    const firstBody = ThreeToImproveResponseSchema.parse(await first.json());
    expect(firstBody.sessionId).toBe(fixture.sessionId);
    expect(firstBody.gameId).toBe("iracing");
    expect(firstBody.state).toBe("no-actionable-findings");
    expect(firstBody.items).toEqual([]);
    expect(firstBody.eligibleLapCount).toBe(1);
    expect(firstBody.analyzedLapCount).toBe(1);

    const second = await request.get(SUMMARY(fixture.sessionId), { headers: { "X-Game-Id": "iracing" } });
    expect(second.status()).toBe(200);
    expect(await second.json()).toEqual(firstBody);
  } finally {
    await fixture.cleanup();
  }
});
