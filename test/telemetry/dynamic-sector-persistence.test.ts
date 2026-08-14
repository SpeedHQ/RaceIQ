import { expect, test } from "bun:test";
import { deleteSession, insertSession } from "../../server/db/session-queries";
import { getLapById, getLaps } from "../../server/db/lap-read-queries";
import { insertLap } from "../../server/db/lap-mutation-queries";
import { DEFAULT_LAP_CLASSIFICATION } from "../../shared/racing/laps/classification";

test("ordered six-sector times round-trip without a three-sector projection", async () => {
  const sessionId = await insertSession(990_134, 991_134, "iracing");
  try {
    const sectorTimes = [8.125, 10.25, 11.375, 12.5, 9.625, 10.75];
    const lapId = await insertLap({
      sessionId,
      lapNumber: 1,
      lapTime: sectorTimes.reduce((sum, time) => sum + time, 0),
      isValid: true,
      rawByteOffset: null,
      rawFrameCount: 0,
      profileId: null,
      tuneId: null,
      invalidReason: null,
      sectors: sectorTimes,
      classification: DEFAULT_LAP_CLASSIFICATION,
      quality: null,
      eligibility: null,
    });

    const stored = (await getLaps("iracing")).find((lap) => lap.id === lapId);
    expect(stored?.sectorTimes).toEqual(sectorTimes);

    const detail = await getLapById(lapId);
    expect(detail?.sectorTimes).toEqual(sectorTimes);
  } finally {
    await deleteSession(sessionId);
  }
});
