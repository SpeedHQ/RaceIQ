import { expect, test } from "@playwright/test";
import { ThreeToImproveResponseSchema } from "../../contracts";
import { importCoachingRecording } from "./coaching-fixtures";
import { setLapFixtureState } from "./coaching-db-fixtures";

test("invalid, non-pace and experiment-excluded laps do not contribute coaching evidence", async ({ request }) => {
  const fixture = await importCoachingRecording(request, {
    label: `coaching-eligibility-${Date.now()}`,
    lapCount: 6,
    signals: ["brake-drag"],
  });
  const restores: Array<() => void> = [];
  try {
    for (const [index, state] of (["invalid", "non-pace", "excluded"] as const).entries()) {
      restores.push(await setLapFixtureState(fixture.lapIds[index]!, state));
    }
    const response = await request.get(`/api/sessions/${fixture.sessionId}/3-to-improve`, {
      headers: { "X-Game-Id": "iracing" },
    });
    expect(response.status()).toBe(200);
    const summary = ThreeToImproveResponseSchema.parse(await response.json());
    expect(summary).toMatchObject({
      state: "ready",
      eligibleLapCount: 3,
      analyzedLapCount: 3,
      excludedLapCount: 3,
    });
    expect(summary.items).toHaveLength(1);
    expect(summary.items[0]).toMatchObject({
      family: "brake-drag",
      supportingLapCount: 3,
      evidencePointCount: 3,
      evidenceLevel: "repeated",
    });
  } finally {
    for (const restore of restores.reverse()) restore();
    await fixture.cleanup();
  }
});
