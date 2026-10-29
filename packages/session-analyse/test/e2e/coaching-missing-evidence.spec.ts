import { expect, test } from "@playwright/test";
import { ThreeToImproveResponseSchema } from "../../contracts";
import { clearSessionCapture, deleteLapFixture } from "./coaching-db-fixtures";
import { importCoachingRecording } from "./coaching-fixtures";

test("missing capture yields insufficient data and missing representative lap remains 404", async ({ request }) => {
  const fixture = await importCoachingRecording(request, { label: `coaching-missing-${Date.now()}`, lapCount: 1, signals: ["brake-drag"] });
  try {
    const summaryUrl = `/api/sessions/${fixture.sessionId}/3-to-improve`;
    const headers = { "X-Game-Id": "iracing" };
    const initial = await request.get(summaryUrl, { headers });
    expect(initial.status()).toBe(200);
    const summary = ThreeToImproveResponseSchema.parse(await initial.json());
    expect(summary.items).toHaveLength(1);
    const item = summary.items[0]!;
    const evidenceUrl = `${summaryUrl}/evidence?lapId=${item.representative.lapId}&sourceFrameIndex=${item.representative.sourceFrameIndex}`;
    const changedEvidence = await request.get(
      `${summaryUrl}/evidence?lapId=${item.representative.lapId}&sourceFrameIndex=999999`,
      { headers },
    );
    expect(changedEvidence.status()).toBe(409);
    expect(await changedEvidence.json()).toEqual({
      code: "COACHING_EVIDENCE_CHANGED",
      error: "Session evidence changed. Refresh the insights.",
    });

    const restoreCapture = await clearSessionCapture(fixture.sessionId);
    try {
      const missingSummary = await request.get(summaryUrl, { headers });
      expect(missingSummary.status()).toBe(200);
      const unavailable = ThreeToImproveResponseSchema.parse(await missingSummary.json());
      expect(unavailable.state).toBe("insufficient-data");
      expect(unavailable.items).toEqual([]);
      expect(unavailable.eligibleLapCount).toBe(1);
      expect(unavailable.analyzedLapCount).toBe(0);
      expect((await request.get(evidenceUrl, { headers })).status()).toBe(404);
    } finally {
      restoreCapture();
    }

    deleteLapFixture(item.representative.lapId);
    expect((await request.get(evidenceUrl, { headers })).status()).toBe(404);
  } finally {
    await fixture.cleanup();
  }
});
