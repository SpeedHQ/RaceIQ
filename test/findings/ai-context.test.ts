import { describe, expect, test } from "bun:test";

import { FINDING_SCHEMA_VERSION, type FindingNarrative, type FindingRecord } from "../../shared/racing/findings/types";
import {
  buildFindingsContext,
  parseCachedFindings,
} from "../../server/ai/findings-context";

function finding(over: Partial<FindingRecord> = {}): FindingRecord {
  const id = over.id ?? "finding-available";
  return {
    schemaVersion: FINDING_SCHEMA_VERSION,
    id,
    type: "lap-insight",
    category: "driving",
    scope: { kind: "corner", gameId: "f1-2025", sessionId: "session-7", lapId: "lap-42", cornerId: "corner-3" },
    status: "available",
    severity: "medium",
    confidence: "high",
    measurements: [{
      id: `${id}:occurrences`,
      type: "occurrence-count",
      value: 2,
      unit: "count",
      sampleCount: 2,
      confidence: "high",
      semanticIds: ["driving.coasting"],
      derivation: { id: "lap-insight-adapter", version: "1" },
    }],
    evidenceRefs: [
      { kind: "lap", id: "lap-ref-42", sessionId: "session-7", lapId: "lap-42" },
      { kind: "corner", id: "corner-ref-3", sessionId: "session-7", lapId: "lap-42", cornerId: "corner-3" },
      { kind: "channel", id: "channel-throttle", sessionId: "session-7", channel: "Throttle" },
    ],
    qualityRefs: [],
    limitations: [],
    rule: { id: "lap-insight-adapter", version: "1", inputs: { detector: "coasting" } },
    analysisGenerationId: "analysis-generation-1",
    title: "Coasting detected",
    ...over,
  };
}

describe("buildFindingsContext", () => {
  test("grounds claims in supplied finding, measurement, scope, and evidence IDs", () => {
    const context = buildFindingsContext([finding()]);

    expect(context).toContain("[FINDING finding-available]");
    expect(context).toContain("lapId=lap-42");
    expect(context).toContain("cornerId=corner-3");
    expect(context).toContain("channel-throttle");
    expect(context).toContain("finding-available:occurrences/occurrence-count=2 count, n=2");
    expect(context).toContain("Correlation or association cannot be upgraded to causation");
  });

  test("keeps low confidence qualified and unavailable or indeterminate records as abstentions", () => {
    const low = finding({ id: "finding-low", confidence: "low" });
    const unavailable = finding({
      id: "finding-unavailable",
      status: "unavailable",
      confidence: "unknown",
      measurements: [],
      evidenceRefs: [],
      limitations: [{ code: "channel-missing", detail: "Brake channel unavailable" }],
    });
    const indeterminate = finding({
      id: "finding-indeterminate",
      status: "indeterminate",
      confidence: "unknown",
      measurements: [],
      evidenceRefs: [],
      limitations: [{ code: "quality-suppressed", detail: "Recording quality rejected" }],
    });

    const context = buildFindingsContext([unavailable, low, indeterminate]);
    expect(context).toContain("confidence=low; do not state as certain");
    expect(context).toContain("[ABSTENTION] finding-unavailable: unavailable (channel-missing: Brake channel unavailable)");
    expect(context).toContain("[ABSTENTION] finding-indeterminate: indeterminate (quality-suppressed: Recording quality rejected)");
  });

  test("does not invent evidence IDs and excludes unsupported recommendations", () => {
    const context = buildFindingsContext([finding()], {
      recommendations: [
        {
          id: "recommendation-supported",
          kind: "coaching",
          text: "Release throttle later",
          supportingFindingIds: ["finding-available"],
          confidence: "medium",
        },
        {
          id: "recommendation-unsupported",
          kind: "coaching",
          text: "Brake at invented corner",
          supportingFindingIds: ["invented-finding"],
          confidence: "high",
        },
      ],
    });

    expect(context).toContain("Release throttle later; supporting findings=finding-available");
    expect(context).not.toContain("Brake at invented corner");
    expect(context).not.toContain("invented-finding");
    expect(context).not.toContain("lap-99");
    expect(context).not.toContain("corner-99");
  });

  test("treats linked narrative as wording rather than new evidence", () => {
    const narratives = [
      {
        id: "narrative-linked",
        findingIds: ["finding-available"],
        text: "Release brake sooner before turn-in.",
        generator: "lap-insight-adapter",
        generationId: "analysis-generation-1",
      },
      {
        id: "narrative-unlinked",
        findingIds: ["invented-finding"],
        text: "Invented guidance",
        generator: "lap-insight-adapter",
        generationId: "analysis-generation-1",
      },
      {
        id: "narrative-malformed",
        findingIds: "finding-available",
        text: "Malformed guidance",
        generator: "lap-insight-adapter",
        generationId: "analysis-generation-1",
      },
    ] as unknown as FindingNarrative[];
    const context = buildFindingsContext([finding()], { narratives });

    expect(context).toContain('[NARRATIVE wording-only; findings=finding-available] wording="Release brake sooner before turn-in."');
    expect(context).toContain("Narratives are wording attached to supplied finding IDs, never evidence or new findings.");
    expect(context).not.toContain("Invented guidance");
    expect(context).not.toContain("Malformed guidance");
  });
});

describe("parseCachedFindings", () => {
  test("accepts structurally valid finding JSON", () => {
    expect(parseCachedFindings(JSON.stringify({ findings: [finding()] }))).toEqual([finding()]);
  });

  test("excludes malformed cached prose and JSON-shaped impostors", () => {
    expect(parseCachedFindings("Model said lap-999 caused understeer")).toEqual([]);
    expect(parseCachedFindings('{"findings":[{"id":"fake","title":"raw prose"}]}')).toEqual([]);
  });
});
