import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { loadDriverProfile } from "../../server/driver-profile/load";
import { db } from "../../server/db";
import { laps, sessions } from "../../server/db/schema";
import { finalizeLapQualityGeneration } from "../../server/lap-analysis/quality-generation";
import type { GameId } from "../../shared/games/ids";
import { qualityPackets, summarize } from "../support/lap-analysis/quality-model";

const gameId = "driver-profile-policy-test" as GameId;
const createdSessionIds: number[] = [];

afterEach(async () => {
  for (const sessionId of createdSessionIds) {
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
  createdSessionIds.length = 0;
});

describe("loadDriverProfile quality policy", () => {
  test("rejects an insufficient eligible lap pool before decoding telemetry", async () => {
    const packets = qualityPackets(100);
    const generated = finalizeLapQualityGeneration(summarize(packets), `sha256:${"1".repeat(64)}`, {
      lapNumber: 1,
      rawByteOffset: 1_000,
      rawFrameCount: packets.length,
    });
    const sessionId = (await db.insert(sessions).values({ carOrdinal: 911, trackOrdinal: 912, gameId }).returning({ id: sessions.id }).get()).id;
    createdSessionIds.push(sessionId);
    await db.insert(laps).values({
      sessionId,
      lapNumber: 1,
      lapTime: 90,
      isValid: true,
      quality: generated.quality,
      eligibility: generated.eligibility,
      qualityGeneration: generated.quality.provenance.outputGeneration,
      qualitySchemaVersion: generated.quality.provenance.schemaVersion,
      qualityPolicyVersion: generated.quality.provenance.policyVersion,
      qualityConfigVersion: generated.quality.provenance.configurationVersion,
    });

    const fingerprint = await loadDriverProfile({ gameId });
    expect(fingerprint.laps.analyzed).toBe(0);
    expect(fingerprint.ok).toBe(false);
    expect(fingerprint.notes).toContain("Suitability unknown: Not enough suitable laps are available.");
  });
});
