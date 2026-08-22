import { expect, test } from "bun:test";
import { deleteSession, getSessions } from "../../server/db/session-queries";
import { getLapById, getLaps } from "../../server/db/lap-read-queries";
import { initServerGameAdapters } from "../../server/games/init";
import {
  currentTelemetryVersionIdentity,
  RealDbAdapter,
} from "../../server/telemetry/pipeline-ports";
import type { TelemetryVersionIdentity } from "../../shared/telemetry/version";
import { DEFAULT_LAP_CLASSIFICATION } from "../../shared/racing/laps/classification";
initServerGameAdapters();

test("production adapter stamps current runtime identity on sessions and laps", async () => {
  const adapter = new RealDbAdapter();
  const expected: TelemetryVersionIdentity =
    currentTelemetryVersionIdentity("iracing");
  expect(expected.derivationVersion).toContain(
    "iracing.race.control.phase@",
  );
  const sessionId = await adapter.insertSession(990_205, 991_205, "iracing");
  try {
    const lapId = await adapter.insertLap({
      sessionId,
      lapNumber: 1,
      lapTime: 88.5,
      isValid: true,
      rawByteOffset: null,
      rawFrameCount: 0,
      profileId: null,
      tuneId: null,
      invalidReason: null,
      sectors: null,
      classification: DEFAULT_LAP_CLASSIFICATION,
      quality: null,
      eligibility: null,
    });

    expect(await getLapById(lapId)).toMatchObject(expected);
    const metadata = (await getLaps("iracing")).find((row) => row.id === lapId);
    expect(metadata).toMatchObject({ ...expected, rawFrameCount: 0 });
    expect(metadata).not.toHaveProperty("telemetry");
    const session = (await getSessions("iracing")).find((row) => row.id === sessionId);
    expect(session).toMatchObject(expected);
  } finally {
    await deleteSession(sessionId);
  }
});
