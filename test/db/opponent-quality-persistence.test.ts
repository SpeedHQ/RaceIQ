import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../server/db";
import { laps, sessions } from "../../server/db/schema";
import { finalizeLapQualityGeneration } from "../../server/lap-analysis/quality-generation";
import { qualityPackets, summarize } from "../support/lap-analysis/quality-model";

const createdSessionIds: number[] = [];

const opponent = {
  kind: "opponent" as const,
  sourceId: "car-7",
  stableId: "driver:opponent-7",
  identityState: "stable" as const,
};

const playerOnlySemanticIds = [
  "inputs.accel",
  "inputs.brake",
  "inputs.steer",
  "fuel.fuel",
  "tire.temperature.average",
  "tires.tire-wear",
  "tires.tire-pressure",
  "tires.tire-slip-ratio",
  "tires.tire-slip-angle",
  "tires.wheel-rotation-speed",
  "suspension.norm-suspension-travel",
] as const;

afterEach(async () => {
  for (const sessionId of createdSessionIds) {
    await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  }
  createdSessionIds.length = 0;
});

describe("opponent lap quality JSON persistence", () => {
  test("roundtrips unavailable player-only channels and reason evidence without zero substitution", async () => {
    const packets = qualityPackets(500, [248, 249]);
    const measured = summarize(packets, {
      participant: opponent,
      eventIds: ["evt:opponent-gap"],
    });
    const generated = finalizeLapQualityGeneration(measured, "sha256:opponent-session", {
      lapNumber: 8,
      rawByteOffset: 256,
      rawFrameCount: packets.length,
    });

    const sessionId = (
      await db
        .insert(sessions)
        .values({
          carOrdinal: 9_236_701,
          trackOrdinal: 9_236_702,
          gameId: "iracing",
          source: "native-live",
        })
        .returning({ id: sessions.id })
        .get()
    ).id;
    createdSessionIds.push(sessionId);

    const lapId = (
      await db
        .insert(laps)
        .values({
          sessionId,
          lapNumber: 8,
          lapTime: 10,
          isValid: true,
          quality: generated.quality,
          eligibility: generated.eligibility,
          qualitySchemaVersion: generated.quality.provenance.schemaVersion,
          qualityPolicyVersion: generated.quality.provenance.policyVersion,
          qualityConfigVersion: generated.quality.provenance.configurationVersion,
          qualityGeneration: generated.quality.provenance.outputGeneration,
        })
        .returning({ id: laps.id })
        .get()
    ).id;

    const stored = await db.select({ quality: laps.quality, eligibility: laps.eligibility }).from(laps).where(eq(laps.id, lapId)).get();

    expect(stored?.quality?.participant).toEqual(opponent);

    const unavailable = stored?.quality?.channelQuality.filter(({ semanticId }) => playerOnlySemanticIds.includes(semanticId as (typeof playerOnlySemanticIds)[number]));
    expect(unavailable).toHaveLength(playerOnlySemanticIds.length);
    for (const channel of unavailable ?? []) {
      expect(channel.mappingStatus).toBe("unavailable");
      expect(channel.coverage).toBeNull();
      expect(channel.confidenceMean).toBeNull();
      expect(channel.observedCadenceMs).toBeNull();
      expect(channel.boundaryCoverage.first500Ms).toBeNull();
      expect(channel.boundaryCoverage.last500Ms).toBeNull();
      expect(channel.coverage).not.toBe(0);
      expect(channel.confidenceMean).not.toBe(0);
    }

    const generatedGapReason = generated.eligibility["normal-pace"].reasons.find(({ code }) => code === "telemetry_gap_minor");
    const storedGapReason = stored?.eligibility?.["normal-pace"].reasons.find(({ code }) => code === "telemetry_gap_minor");
    expect(generatedGapReason).toBeDefined();
    expect(generatedGapReason!.evidenceIds.length).toBeGreaterThan(0);
    expect(storedGapReason).toBeDefined();
    expect(storedGapReason!.evidenceIds).toEqual(generatedGapReason!.evidenceIds);

    const generatedOpponentReason = generated.eligibility["ml-training"].reasons.find(({ code }) => code === "opponent_channel_unavailable");
    const storedOpponentReason = stored?.eligibility?.["ml-training"].reasons.find(({ code }) => code === "opponent_channel_unavailable");
    expect(generatedOpponentReason).toBeDefined();
    expect(generatedOpponentReason!.evidenceIds.length).toBeGreaterThan(0);
    expect(storedOpponentReason).toBeDefined();
    expect(storedOpponentReason!.evidenceIds).toEqual(generatedOpponentReason!.evidenceIds);
  });
});
