import { describe, expect, test } from "bun:test";

import { buildDriverProfilerPrompt } from "../server/driver-profile/prompt";
import { emptyFingerprint, type DriverFingerprint } from "../server/driver-profile/fingerprint";
import type { DriverTrend } from "../server/driver-profile/trend";
import { parseDriverProfileSummary, DriverProfileSummarySchema } from "../server/ai/schemas";

function trend(over: Partial<DriverTrend> = {}): DriverTrend {
  const window = {
    laps: [],
    total: 12,
    valid: 9,
    dirty: 3,
    cleanRate: 0.75,
    normalized: 12,
    consistency: 84,
    medianPacePct: 2.4,
    spreadPct: 1.7,
    contexts: 2,
  };
  return {
    recent: window,
    previous: { ...window, total: 10, valid: 8, dirty: 2, cleanRate: 0.8, consistency: 79, medianPacePct: 3.1, spreadPct: 2.2 },
    consistencyDelta: 5,
    paceDeltaPct: -0.7,
    spreadDeltaPct: -0.5,
    cleanRateDelta: -0.05,
    consistencyDirection: "improving",
    paceDirection: "improving",
    validityDirection: "declining",
    advice: [{ id: "stabilize-pace", tone: "neutral", title: "Stabilize pace", detail: "Keep the current approach while reducing variation." }],
    ...over,
  };
}

function fingerprint(over: Partial<DriverFingerprint> = {}): DriverFingerprint {
  const base = emptyFingerprint({ kind: "global", gameId: "fm-2023", carOrdinal: null, trackOrdinal: null }, {}, [], trend());
  return { ...base, ok: true, trend: trend(), ...over };
}

describe("DriverProfileSummarySchema", () => {
  const valid = { headline: "More consistent pace", summary: "The recent window is credible because it contains enough measured laps and shows tighter normalized pace spread. Consistency improved while the relative pace median moved closer to baseline." };

  test("accepts exactly the two bounded summary fields", () => {
    expect(DriverProfileSummarySchema.safeParse(valid).success).toBe(true);
    expect(DriverProfileSummarySchema.safeParse({ headline: "", summary: "x" }).success).toBe(false);
    expect(DriverProfileSummarySchema.safeParse({ headline: "x", summary: "x", sessionPlan: [] }).success).toBe(false);
  });

  test("rejects legacy plan fields and overlong prose", () => {
    expect(DriverProfileSummarySchema.safeParse({ ...valid, styleLabel: "steady" }).success).toBe(false);
    expect(DriverProfileSummarySchema.safeParse({ headline: "x".repeat(81), summary: "x" }).success).toBe(false);
    expect(DriverProfileSummarySchema.safeParse({ headline: "x", summary: "x".repeat(601) }).success).toBe(false);
  });

  test("parses leading prose and markdown fences", () => {
    const parsed = parseDriverProfileSummary(`Here you go:\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\``);
    expect(parsed.success).toBe(true);
    expect(parseDriverProfileSummary('{"headline":"cut off').success).toBe(false);
  });
});

describe("buildDriverProfilerPrompt", () => {
  test("hands off both trend windows, normalized metrics, directions, and advice", () => {
    const prompt = buildDriverProfilerPrompt({ fingerprint: fingerprint() });
    expect(prompt).toContain("Recent window: 12 laps (9 clean, 3 dirty)");
    expect(prompt).toContain("Previous window: 10 laps (8 clean, 2 dirty)");
    expect(prompt).toContain("consistency 84/100");
    expect(prompt).toContain("median relative pace 2.4%");
    expect(prompt).toContain("spread 1.7%");
    expect(prompt).toContain("Directions: pace improving, consistency improving, validity declining.");
    expect(prompt).toContain("Stabilize pace: Keep the current approach while reducing variation.");
  });

  test("excludes scoped names, raw lap identifiers, detector/style vocabulary, and plans", () => {
    const prompt = buildDriverProfilerPrompt({ fingerprint: fingerprint(), language: "en" });
    expect(prompt).not.toContain("Porsche 911");
    expect(prompt).not.toContain("Road Atlanta");
    expect(prompt).not.toContain("lap id");
    expect(prompt).not.toContain("detector");
    expect(prompt).not.toContain("style gauge");
    expect(prompt).not.toContain("next-session plan");
    expect(prompt).toContain("Do not make recommendations");
  });

  test("preserves non-English language directive", () => {
    expect(buildDriverProfilerPrompt({ fingerprint: fingerprint(), language: "de" })).toContain('Write all prose in language code "de".');
  });
});
