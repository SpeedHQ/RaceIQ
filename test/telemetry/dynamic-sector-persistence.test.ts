import { expect, test } from "bun:test";
import { deleteSession, insertSession } from "../../server/db/session-queries";
import { getLapById, getLaps } from "../../server/db/lap-read-queries";
import { insertLap } from "../../server/db/lap-mutation-queries";

test("ordered six-sector times round-trip without a three-sector projection", async () => {
  const sessionId = await insertSession(990_134, 991_134, "iracing");
  try {
    const sectorTimes = [8.125, 10.25, 11.375, 12.5, 9.625, 10.75];
    const lapId = await insertLap(
      sessionId,
      1,
      sectorTimes.reduce((sum, time) => sum + time, 0),
      true,
      null,
      0,
      null,
      null,
      null,
      sectorTimes,
    );

    const stored = (await getLaps("iracing")).find((lap) => lap.id === lapId);
    expect(stored?.sectorTimes).toEqual(sectorTimes);

    const detail = await getLapById(lapId);
    expect(detail?.sectorTimes).toEqual(sectorTimes);
  } finally {
    await deleteSession(sessionId);
  }
});
