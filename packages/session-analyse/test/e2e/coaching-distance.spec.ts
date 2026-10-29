import { expect, test } from "@playwright/test";
import { decodeAlignedLapSet } from "@raceiq/analysis-core/racing/laps/alignment/codec";
import { ThreeToImproveResponseSchema } from "../../contracts";
import { setLapInsightSourceFrame } from "./coaching-db-fixtures";
import { importCoachingRecording } from "./coaching-fixtures";

const recordedFraction = (frame: number) => {
  const u = frame / 600;
  return u - 0.04 * Math.sin(2 * Math.PI * u);
};

test("coaching marker location follows recorded distance on variable-speed native recording", async ({ page, request }) => {
  const fixture = await importCoachingRecording(request, {
    label: `coaching-distance-${Date.now()}`,
    lapCount: 1,
    signals: ["brake-drag"],
    distanceProfile: "variable",
  });
  try {
    const response = await request.get(`/api/sessions/${fixture.sessionId}/3-to-improve`, {
      headers: { "X-Game-Id": "iracing" },
    });
    expect(response.status()).toBe(200);
    const summary = ThreeToImproveResponseSchema.parse(await response.json());
    expect(summary.items.map(({ id }) => id)).toEqual(["brake-drag:6"]);
    const item = summary.items[0]!;
    expect(item.representative.sourceFrameIndex).toBe(105);
    const expectedFraction = recordedFraction(105) / recordedFraction(599);
    expect(item.location.fraction).toBeCloseTo(expectedFraction, 12);
    expect(Math.abs(item.location.fraction - 105 / 599)).toBeGreaterThan(0.005);

    const detailResponse = await request.get(
      `/api/sessions/${fixture.sessionId}/3-to-improve/evidence?lapId=${item.representative.lapId}&sourceFrameIndex=${item.representative.sourceFrameIndex}`,
      { headers: { "X-Game-Id": "iracing" } },
    );
    expect(detailResponse.status()).toBe(200);
    const detail = await detailResponse.json() as {
      representative: { sourceFrameIndex: number };
      fraction: number;
      aligned: Parameters<typeof decodeAlignedLapSet>[0];
    };
    expect(detail.representative.sourceFrameIndex).toBe(105);
    expect(detail.fraction).toBeCloseTo(expectedFraction, 12);
    const aligned = decodeAlignedLapSet(detail.aligned);
    expect(aligned.laps).toHaveLength(1);
    const lap = aligned.laps[0]!;
    const expectedSpeed = (1 - 0.08 * Math.PI * Math.cos(2 * Math.PI * (105 / 600))) * 4_000 / 60;
    expect(lap.speedMps.some((speed) => Math.abs(speed - expectedSpeed) < 0.02)).toBe(true);

    const headers = { "X-Game-Id": "iracing" };
    const mutatedFinding = setLapInsightSourceFrame(fixture.lapIds[0]!, 0);
    expect(mutatedFinding.insightVersion).toBeGreaterThan(0);
    expect(mutatedFinding.finding).toMatchObject({ id: "driving-brake-drag", frameIndices: [105] });
    for (const { frame, id } of [
      { frame: 0, id: "brake-drag:0" },
      { frame: 15, id: "brake-drag:0" },
      { frame: 16, id: "brake-drag:1" },
      { frame: 599, id: "brake-drag:49" },
    ]) {
      if (frame !== 0) {
        const previous = setLapInsightSourceFrame(fixture.lapIds[0]!, frame);
        expect(previous.insightVersion).toBe(mutatedFinding.insightVersion);
        expect(previous.finding.id).toBe("driving-brake-drag");
        expect(previous.finding.frameIndices).toEqual([frame === 15 ? 0 : frame === 16 ? 15 : 16]);
      }
      const boundaryResponse = await request.get(`/api/sessions/${fixture.sessionId}/3-to-improve`, { headers });
      expect(boundaryResponse.status()).toBe(200);
      const boundarySummary = ThreeToImproveResponseSchema.parse(await boundaryResponse.json());
      expect(boundarySummary.items.map(({ id: itemId }) => itemId)).toEqual([id]);
      expect(boundarySummary.items[0]!.representative).toMatchObject({ lapId: fixture.lapIds[0], sourceFrameIndex: frame });
      expect(boundarySummary.items[0]!.location.fraction).toBeCloseTo(recordedFraction(frame) / recordedFraction(599), 12);

      if (frame === 599) {
        const endEvidenceResponse = await request.get(
          `/api/sessions/${fixture.sessionId}/3-to-improve/evidence?lapId=${fixture.lapIds[0]}&sourceFrameIndex=599`,
          { headers },
        );
        expect(endEvidenceResponse.status()).toBe(200);
        const endEvidence = await endEvidenceResponse.json() as {
          representative: { sourceFrameIndex: number };
          fraction: number;
          aligned: Parameters<typeof decodeAlignedLapSet>[0];
        };
        expect(endEvidence.representative.sourceFrameIndex).toBe(599);
        expect(endEvidence.fraction).toBe(1);
        expect(decodeAlignedLapSet(endEvidence.aligned).laps.map(({ lapId }) => lapId)).toEqual([fixture.lapIds[0]]);
      }
    }

    await page.goto(`/iracing/sessions/${fixture.sessionId}/analyse`, { waitUntil: "domcontentloaded" });
    const marker = page.locator('[data-coaching-family="brake-drag"]');
    await expect(marker).toBeVisible();
    await marker.getByRole("button").click();
    await expect(page.getByTestId("three-to-improve-evidence")).toBeVisible();
  } finally {
    await fixture.cleanup();
  }
});
