import { afterEach, expect, test } from "bun:test";
import { eq, inArray, or } from "drizzle-orm";
import { db } from "../../server/db";
import {
  analysisQualityIdentityForLap,
  getAnalysis,
  getCompareAnalysis,
  saveAnalysis,
  saveCompareAnalysis,
  type AnalysisQualityIdentity,
  type FindingGenerationExpectation,
} from "../../server/db/analysis-queries";
import { insertLap } from "../../server/db/lap-mutation-queries";
import {
  compareAnalyses,
  findingGenerations,
  lapAnalyses,
  laps,
} from "../../server/db/schema";
import { deleteSession, insertSession } from "../../server/db/session-queries";
import { combineQualityGenerations, finalizeLapQualityGeneration } from "../../server/lap-analysis/quality-generation";
import type { GameId } from "../../shared/games/ids";
import { canonicalJson } from "../../shared/racing/findings/identity";
import {
  FINDING_SCHEMA_VERSION,
  type FindingScope,
} from "../../shared/racing/findings/types";
import { ELIGIBILITY_POLICY_VERSION } from "../../shared/racing/quality/contracts";
import { qualityPackets, summarize, TEST_VERSION_IDENTITY } from "../support/lap-analysis/quality-model";

const sessionIds: number[] = [];
const lapIds: number[] = [];
const testGameId = "analysis-quality-cache-test" as GameId;
const usage = {
  inputTokens: 10,
  outputTokens: 20,
  costUsd: 0.01,
  durationMs: 30,
  model: "test-model",
};
const noQualityIdentity: AnalysisQualityIdentity = {
  hasQuality: false,
  qualityGeneration: null,
  qualityPolicyVersion: null,
};

async function createLap(lapNumber: number, withQuality: boolean) {
  const sessionId = await insertSession(995_000 + lapNumber, 996_000 + lapNumber, testGameId, "practice", TEST_VERSION_IDENTITY);
  sessionIds.push(sessionId);
  const generated = withQuality ? finalizeLapQualityGeneration(summarize(qualityPackets(50)), `sha256:${"a".repeat(64)}`, { lapNumber, rawByteOffset: null, rawFrameCount: 50 }) : null;
  const lapId = await insertLap({
    sessionId,
    lapNumber,
    lapTime: 10,
    isValid: true,
    rawByteOffset: null,
    rawFrameCount: 50,
    profileId: null,
    tuneId: null,
    invalidReason: null,
    sectors: null,
    quality: generated?.quality ?? null,
    eligibility: generated?.eligibility ?? null,
  });
  lapIds.push(lapId);
  return {
    sessionId,
    lapId,
    identity: generated
      ? analysisQualityIdentityForLap({
          quality: generated.quality,
          qualityGeneration: generated.quality.provenance.outputGeneration,
        })
      : noQualityIdentity,
  };
}

async function createFindingExpectation(
  lap: { sessionId: number; lapId: number },
  hashDigit: string,
): Promise<FindingGenerationExpectation> {
  const scope: FindingScope = {
    kind: "lap",
    gameId: testGameId,
    sessionId: String(lap.sessionId),
    lapId: String(lap.lapId),
  };
  const expectation = {
    scope,
    generationId: `finding-cache-${crypto.randomUUID()}`,
    contentHash: `sha256:${hashDigit.repeat(64)}`,
  } satisfies FindingGenerationExpectation;
  await db.insert(findingGenerations).values({
    id: expectation.generationId,
    lapId: lap.lapId,
    scopeKey: canonicalJson(scope),
    scope: canonicalJson(scope),
    sourceId: `source:${lap.lapId}`,
    rule: canonicalJson({ id: "cache-test", version: "1" }),
    config: canonicalJson({}),
    schemaVersion: FINDING_SCHEMA_VERSION,
    status: "current",
    findingCount: 0,
    availableCount: 0,
    unavailableCount: 0,
    indeterminateCount: 0,
    contentHash: expectation.contentHash,
    verifiedAt: new Date().toISOString(),
    activatedAt: new Date().toISOString(),
  });
  return expectation;
}

afterEach(async () => {
  if (lapIds.length > 0) {
    await db
      .delete(compareAnalyses)
      .where(or(inArray(compareAnalyses.lapAId, lapIds), inArray(compareAnalyses.lapBId, lapIds)))
      .run();
    await db.delete(lapAnalyses).where(inArray(lapAnalyses.lapId, lapIds)).run();
  }
  lapIds.splice(0);
  for (const sessionId of sessionIds.splice(0)) await deleteSession(sessionId);
});

test("lap analysis cache requires the exact current quality identity", async () => {
  const current = await createLap(1, true);
  await saveAnalysis(current.lapId, "current", usage, current.identity);

  expect(await getAnalysis(current.lapId)).toMatchObject({ analysis: "current" });
  const stored = await db
    .select({
      qualityGeneration: lapAnalyses.qualityGeneration,
      qualityPolicyVersion: lapAnalyses.qualityPolicyVersion,
    })
    .from(lapAnalyses)
    .where(eq(lapAnalyses.lapId, current.lapId))
    .get();
  expect(stored).toEqual({
    qualityGeneration: current.identity.qualityGeneration,
    qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
  });

  await db.update(lapAnalyses).set({ qualityPolicyVersion: "legacy" }).where(eq(lapAnalyses.lapId, current.lapId)).run();
  expect(await getAnalysis(current.lapId)).toBeNull();
  await db
    .update(lapAnalyses)
    .set({
      qualityGeneration: `sha256:${"b".repeat(64)}`,
      qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
    })
    .where(eq(lapAnalyses.lapId, current.lapId))
    .run();
  expect(await getAnalysis(current.lapId)).toBeNull();

  const legacyIdentity: AnalysisQualityIdentity = {
    hasQuality: true,
    qualityGeneration: "legacy",
    qualityPolicyVersion: "legacy",
  };
  await saveAnalysis(current.lapId, "must not overwrite", usage, legacyIdentity);
  expect(await db.select({ analysis: lapAnalyses.analysis }).from(lapAnalyses).where(eq(lapAnalyses.lapId, current.lapId)).get()).toEqual({ analysis: "current" });
});

test("lap analysis cache rejects missing quality identity", async () => {
  const withoutQuality = await createLap(2, false);
  await saveAnalysis(withoutQuality.lapId, "must-not-cache", usage, withoutQuality.identity);

  expect(await getAnalysis(withoutQuality.lapId)).toBeNull();
  expect(await db.select({ id: lapAnalyses.id }).from(lapAnalyses).where(eq(lapAnalyses.lapId, withoutQuality.lapId)).get()).toBeUndefined();
});

test("compare cache combines two current identities and rejects mixed quality", async () => {
  const left = await createLap(3, true);
  const right = await createLap(4, true);
  await saveCompareAnalysis(right.lapId, left.lapId, "current pair", usage, [right.identity, left.identity]);

  expect(await getCompareAnalysis(left.lapId, right.lapId)).toMatchObject({
    analysis: "current pair",
  });
  expect(
    await db
      .select({
        qualityGeneration: compareAnalyses.qualityGeneration,
        qualityPolicyVersion: compareAnalyses.qualityPolicyVersion,
      })
      .from(compareAnalyses)
      .where(eq(compareAnalyses.analysis, "current pair"))
      .get(),
  ).toEqual({
    qualityGeneration: combineQualityGenerations([left.identity.qualityGeneration!, right.identity.qualityGeneration!]),
    qualityPolicyVersion: ELIGIBILITY_POLICY_VERSION,
  });
  await db
    .update(compareAnalyses)
    .set({ qualityGeneration: `sha256:${"b".repeat(64)}` })
    .where(eq(compareAnalyses.analysis, "current pair"))
    .run();
  expect(await getCompareAnalysis(left.lapId, right.lapId)).toBeNull();

  const withoutQuality = await createLap(5, false);
  await saveCompareAnalysis(left.lapId, withoutQuality.lapId, "mixed pair", usage, [left.identity, withoutQuality.identity]);
  expect(await db.select({ id: compareAnalyses.id }).from(compareAnalyses).where(eq(compareAnalyses.analysis, "mixed pair")).get()).toBeUndefined();

  const noQualityPeer = await createLap(6, false);
  await saveCompareAnalysis(withoutQuality.lapId, noQualityPeer.lapId, "null pair", usage, [withoutQuality.identity, noQualityPeer.identity]);
  expect(await getCompareAnalysis(withoutQuality.lapId, noQualityPeer.lapId)).toBeNull();
});

test("lap analysis cache rejects stale finding generations independently of quality", async () => {
  const current = await createLap(7, true);
  const findings = await createFindingExpectation(current, "b");

  await saveAnalysis(
    current.lapId,
    "finding-grounded",
    usage,
    current.identity,
    findings,
  );

  expect(await getAnalysis(current.lapId, findings)).toMatchObject({
    analysis: "finding-grounded",
  });
  expect(await getAnalysis(current.lapId)).toBeNull();
  expect(
    await db
      .select({ findingGenerationKey: lapAnalyses.findingGenerationKey })
      .from(lapAnalyses)
      .where(eq(lapAnalyses.lapId, current.lapId))
      .get(),
  ).toMatchObject({ findingGenerationKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });

  await db
    .update(findingGenerations)
    .set({ status: "stale-rebuild-available" })
    .where(eq(findingGenerations.id, findings.generationId))
    .run();

  expect(await getAnalysis(current.lapId, findings)).toBeNull();
});

test("comparison cache uses canonical lap ids and current finding generations", async () => {
  const left = await createLap(8, true);
  const right = await createLap(9, true);
  const leftFindings = await createFindingExpectation(left, "c");
  const rightFindings = await createFindingExpectation(right, "d");

  await saveCompareAnalysis(
    right.lapId,
    left.lapId,
    "finding-grounded pair",
    usage,
    [right.identity, left.identity],
    "inputs",
    [rightFindings, leftFindings],
  );

  expect(
    await getCompareAnalysis(
      left.lapId,
      right.lapId,
      "inputs",
      [leftFindings, rightFindings],
    ),
  ).toMatchObject({ analysis: "finding-grounded pair" });
  expect(await getCompareAnalysis(left.lapId, right.lapId)).toBeNull();
  expect(
    await db
      .select({
        lapAId: compareAnalyses.lapAId,
        lapBId: compareAnalyses.lapBId,
        findingGenerationKey: compareAnalyses.findingGenerationKey,
      })
      .from(compareAnalyses)
      .where(eq(compareAnalyses.analysis, "finding-grounded pair"))
      .get(),
  ).toEqual({
    lapAId: left.lapId,
    lapBId: right.lapId,
    findingGenerationKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
  });

  await db
    .update(findingGenerations)
    .set({ status: "stale-rebuild-available" })
    .where(eq(findingGenerations.id, rightFindings.generationId))
    .run();

  expect(
    await getCompareAnalysis(
      left.lapId,
      right.lapId,
      "inputs",
      [leftFindings, rightFindings],
    ),
  ).toBeNull();
});
