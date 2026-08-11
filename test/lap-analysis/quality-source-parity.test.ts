import { describe, expect, test } from "bun:test";
import type { EligibilityDecision, EligibilityDecisionSet, EligibilityPolicyId } from "../../shared/racing/quality/contracts";
import { LOCAL_PLAYER_EVIDENCE } from "../../shared/racing/quality/contracts";
import { finalizeLapQualityGeneration } from "../../server/lap-analysis/quality-generation";
import { evaluateAllEligibility } from "../../shared/racing/quality/policies";
import { RecordingQualityAccumulator } from "../../shared/racing/quality/measure";
import type { TelemetryPacket } from "../../shared/telemetry/types";
import { qualityPackets, summarize, TEST_VERSION_IDENTITY } from "./quality-model.test";

function stripNativeSequence(packets: readonly TelemetryPacket[]): TelemetryPacket[] {
  return packets.map((packet) => ({
    ...packet,
    iracing: undefined,
  }));
}

function normalizeEligibilityReasons(decisions: EligibilityDecisionSet): Record<string, { status: EligibilityDecision["status"]; reasons: string[] }> {
  return Object.fromEntries(
    Object.entries(decisions).map(([policyId, decision]) => [
      policyId as EligibilityPolicyId,
      {
        status: decision.status,
        reasons: decision.reasons
          .filter(({ code }) => code !== "imported_source")
          .map(({ code }) => code)
          .sort(),
      },
    ]),
  ) as Record<string, { status: EligibilityDecision["status"]; reasons: string[] }>;
}

describe("remote source packet-loss evidence", () => {
  const skippedPackets = [248, 249];
  const eventIds = ["evt:remote-loss"];
  const packets = qualityPackets(500, skippedPackets);
  const nativeSequencePackets = packets;
  const timestampOnlyPackets = stripNativeSequence(packets);

  test("flags remote_packet_loss only when native sequence proves packet loss", () => {
    const native = summarize(nativeSequencePackets, {
      sourceKind: "remote-collector",
      eventIds,
    });

    const recorder = new RecordingQualityAccumulator("remote-collector", LOCAL_PLAYER_EVIDENCE, TEST_VERSION_IDENTITY);
    for (const packet of nativeSequencePackets) recorder.observe(packet);
    const finalized = recorder.finalize("complete", { state: "verified", sourceGeneration: "sha256:remote-source" });

    expect(finalized.gapSummary.countMethod).toBe("native-sequence");
    expect(finalized.gapSummary.totalMissingCount).toBe(2);
    expect(native.gapSummary.countMethod).toBe("native-sequence");
    expect(native.gapSummary.totalMissingCount).toBe(2);

    const remoteLoss = native.facts.find((fact) => fact.code === "remote_packet_loss");
    const gap = native.facts.find((fact) => fact.code === "telemetry_gap_minor");
    expect(remoteLoss).toBeDefined();
    expect(gap).toBeDefined();
    expect(remoteLoss!.details).toMatchObject({
      count: native.gapSummary.totalMissingCount,
    });
    expect(remoteLoss!.timeRange).toEqual(gap!.timeRange);
    expect(remoteLoss!.distanceRange).toEqual(gap!.distanceRange);
    expect(remoteLoss!.eventIds).toEqual(eventIds);

    expect(gap!.details?.inferredMissingCount).toBe(2);
    expect(gap!.eventIds).toEqual(eventIds);
    expect(gap!.timeRange).not.toBeNull();
    expect(gap!.distanceRange).not.toBeNull();

    const byTimestampOnly = summarize(timestampOnlyPackets, {
      sourceKind: "remote-collector",
      eventIds,
    });
    expect(timestampOnlyPackets[0]!.TimestampMS).toBe(nativeSequencePackets[0]!.TimestampMS);
    expect(timestampOnlyPackets[timestampOnlyPackets.length - 1]!.TimestampMS).toBe(nativeSequencePackets[nativeSequencePackets.length - 1]!.TimestampMS);
    expect(byTimestampOnly.gapSummary.countMethod).toBe("timestamp-estimate");
    expect(byTimestampOnly.facts.some((fact) => fact.code === "remote_packet_loss")).toBe(false);
  });

  test("local collection must not be mislabeled as remote loss", () => {
    const native = summarize(nativeSequencePackets, { sourceKind: "native-live" });
    expect(native.facts.some((fact) => fact.code === "remote_packet_loss")).toBe(false);
  });
});

describe("cross-source policy parity", () => {
  const skipped = [120, 121];
  const sourceKinds = ["native-live", "raceiq-raw", "raceiq-archive", "iracing-ibt"] as const;
  const packets = qualityPackets(240, skipped);
  const evidence = sourceKinds.map((sourceKind) => {
    const measured = summarize(packets, {
      sourceKind,
      eventIds: ["evt:source-parity"],
      versionIdentity: TEST_VERSION_IDENTITY,
    });

    return {
      sourceKind,
      measured,
      finalized: finalizeLapQualityGeneration(measured, "sha256:cross-source-session", {
        lapNumber: 1,
        rawByteOffset: null,
        rawFrameCount: packets.length,
      }),
    };
  });

  test("preserves policy status and reason codes after removing provenance-only reasons", () => {
    const native = evidence.find(({ sourceKind }) => sourceKind === "native-live")!;
    const baseline = normalizeEligibilityReasons(native.finalized.eligibility);

    for (const sample of evidence) {
      expect(normalizeEligibilityReasons(sample.finalized.eligibility)).toEqual(baseline);
      expect(normalizeEligibilityReasons(evaluateAllEligibility(sample.finalized.quality))).toEqual(baseline);
    }
  });

  test("keeps provenance generations source-specific and non-null", () => {
    const provenance = evidence.map(({ sourceKind, finalized }) => ({
      sourceKind,
      provenance: finalized.quality.provenance,
      outputGeneration: finalized.quality.provenance.outputGeneration,
    }));

    const sourceGeneration = new Set(provenance.map((entry) => entry.provenance.sourceGeneration));
    const outputGeneration = new Set(provenance.map((entry) => entry.outputGeneration));
    expect(sourceGeneration.size).toBe(sourceKinds.length);
    expect(outputGeneration.size).toBe(sourceKinds.length);

    for (const { provenance: resolved } of provenance) {
      expect(resolved.sourceGeneration).toMatch(/^sha256:/);
      expect(resolved.outputGeneration).toMatch(/^sha256:/);
      expect(resolved.schemaVersion).toBeTruthy();
      expect(resolved.policyVersion).toBeTruthy();
      expect(resolved.configurationVersion).toBeTruthy();
    }
  });
});
