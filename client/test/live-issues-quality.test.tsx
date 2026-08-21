import { describe, expect, test } from "bun:test";
import type { EligibilityDecision } from "../../shared/racing/quality/contracts";
import { buildLiveIssueFeedPresentation } from "../src/components/tunes/LiveIssuesFeed";

const blockedDecision: EligibilityDecision = {
  status: "ineligible",
  policyId: "corner-trace",
  policyVersion: "1",
  confidence: { level: "high", score: 1 },
  reasons: [
    {
      code: "channel_unavailable",
      severity: "error",
      evidenceIds: ["test:channel"],
      timeRange: null,
      distanceRange: null,
      semanticIds: ["motion.speed"],
    },
  ],
  evidenceIds: ["test:channel"],
};

describe("live issue quality status", () => {
  test("shows policy reason instead of claiming no issues when analysis is unavailable", () => {
    const presentation = buildLiveIssueFeedPresentation([{ lapId: 12, lapNumber: 4, issues: [], eligibility: blockedDecision }]);

    expect(presentation.blocked).toEqual([{ lapId: 12, lapNumber: 4, text: "Not suitable: Required telemetry channel is unavailable." }]);
    expect(presentation.showNoIssues).toBe(false);
  });
});
