import { expect, test, type APIRequestContext } from "@playwright/test";
import { ThreeToImproveResponseSchema } from "../../contracts";
import { replaceCaptureWithCorruptFixture, setLapFixtureState, setLapInsightsToInvalidSourceIndices } from "./coaching-db-fixtures";
import { importCoachingRecording } from "./coaching-fixtures";

const headers = { "X-Game-Id": "iracing" };
async function summary(request: APIRequestContext, sessionId: number) {
  return request.get(`/api/sessions/${sessionId}/3-to-improve`, { headers });
}

test("captures without location or anomaly signals never produce fabricated advice", async ({ request }) => {
  const noDistance = await importCoachingRecording(request, {
    label: `coaching-no-distance-${Date.now()}`,
    signals: ["brake-drag"],
    omittedChannels: ["distance", "speed", "position"],
  });
  const restoreMissingLocationEligibility = await setLapFixtureState(noDistance.lapIds[0]!, "valid");
  const unsupportedInputs = await importCoachingRecording(request, {
    label: `coaching-unsupported-inputs-${Date.now()}`,
    lapCount: 1,
    signals: ["brake-drag", "downshift", "steering", "throttle"],
    inputs: [],
  });
  const noAnomaly = await importCoachingRecording(request, {
    label: `coaching-no-anomaly-${Date.now()}`,
    lapCount: 1,
    signals: [],
  });
  try {
    const unsupportedResponse = await summary(request, unsupportedInputs.sessionId);
    expect(unsupportedResponse.status()).toBe(200);
    const unsupported = ThreeToImproveResponseSchema.parse(await unsupportedResponse.json());
    expect(unsupported.state).toBe("no-actionable-findings");
    expect(unsupported.items).toEqual([]);
    expect(unsupported.eligibleLapCount).toBe(1);
    expect(unsupported.analyzedLapCount).toBe(1);

    const missingLocationResponse = await summary(request, noDistance.sessionId);
    expect(missingLocationResponse.status()).toBe(200);
    const missingLocation = ThreeToImproveResponseSchema.parse(await missingLocationResponse.json());
    expect(missingLocation.state).toBe("insufficient-data");
    expect(missingLocation.items).toEqual([]);
    expect(missingLocation.eligibleLapCount).toBe(1);
    expect(missingLocation.analyzedLapCount).toBe(1);
    expect(missingLocation.unlocatedEvidenceCount).toBeGreaterThan(0);

    const noAnomalyResponse = await summary(request, noAnomaly.sessionId);
    expect(noAnomalyResponse.status()).toBe(200);
    const normalInputs = ThreeToImproveResponseSchema.parse(await noAnomalyResponse.json());
    expect(normalInputs.state).toBe("no-actionable-findings");
    expect(normalInputs.items).toEqual([]);
  } finally {
    restoreMissingLocationEligibility();
    await unsupportedInputs.cleanup();
    await noAnomaly.cleanup();
    await noDistance.cleanup();
  }
});

test("invalid cached source frame indices are withheld without sample fallback", async ({ request }) => {
  const fixture = await importCoachingRecording(request, {
    label: `coaching-invalid-source-indices-${Date.now()}`,
    lapCount: 1,
    signals: ["brake-drag"],
  });
  try {
    const baselineResponse = await summary(request, fixture.sessionId);
    expect(baselineResponse.status()).toBe(200);
    const baseline = ThreeToImproveResponseSchema.parse(await baselineResponse.json());
    expect(baseline.state).toBe("ready");
    expect(baseline.items.map((item) => item.family)).toEqual(["brake-drag"]);
    setLapInsightsToInvalidSourceIndices(fixture.lapIds[0]!);
    const response = await summary(request, fixture.sessionId);
    expect(response.status()).toBe(200);
    const result = ThreeToImproveResponseSchema.parse(await response.json());
    expect(result.state).toBe("insufficient-data");
    expect(result.eligibleLapCount).toBe(1);
    expect(result.analyzedLapCount).toBe(1);
    expect(result.items).toEqual([]);
    expect(result.unlocatedEvidenceCount).toBe(2);
  } finally {
    await fixture.cleanup();
  }
});

test("corrupt stored capture propagates as application error, not successful empty summary", async ({ request }) => {
  const fixture = await importCoachingRecording(request, {
    label: `coaching-corrupt-${Date.now()}`,
    lapCount: 1,
    signals: ["brake-drag"],
  });
  try {
    const restoreCapture = replaceCaptureWithCorruptFixture(fixture.sessionId);
    try {
      const response = await summary(request, fixture.sessionId);
      expect(response.status()).toBe(500);
    } finally {
      restoreCapture();
    }
  } finally {
    await fixture.cleanup();
  }
});
