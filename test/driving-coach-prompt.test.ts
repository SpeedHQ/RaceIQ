import { describe, test, expect } from "bun:test";
import { buildDrivingCoachPrompt } from "../server/ai/driving-coach-prompt";
import { emptyFingerprint, type DriverFingerprint, type RankedWeakness, type StyleAxes } from "../server/ai/driver-profile-aggregate";
import { parseDriverProfileOutput, DriverProfileOutputSchema } from "../server/ai/schemas";
import { driverProfileScopeKey } from "../server/db/queries";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function weakness(over: Partial<RankedWeakness> = {}): RankedWeakness {
  return {
    id: "driving-early-braking",
    category: "driving",
    label: "Early braking",
    perLapFrequency: 0.8,
    lapsAffected: 8,
    meanSeverityWeight: 2,
    peakSeverity: "warning",
    medianTimeLossS: 0.25,
    lapsQuantified: 8,
    sampleDetail: "Braked 30 m early into T4",
    score: 0.13,
    timeLossKnown: true,
    ...over,
  };
}

function style(over: Partial<StyleAxes> = {}): StyleAxes {
  return {
    gripUtilMedian: 0.72,
    gripUtilP95: 1.05,
    balanceMedianDeg: 2.1,
    understeerFraction: 0.4,
    oversteerFraction: 0.1,
    controlLossFraction: 0.02,
    steerReversalsPerS: 1.4,
    slipVariabilityDeg: 0.9,
    brakingStyle: -45,
    consistency: 88,
    physicsLaps: 10,
    ...over,
  };
}

function fingerprint(over: Partial<DriverFingerprint> = {}): DriverFingerprint {
  const base = emptyFingerprint({ kind: "car-track", gameId: "fm-2023", carOrdinal: 5, trackOrdinal: 9 });
  return {
    ...base,
    ok: true,
    confidence: "high",
    laps: { ...base.laps, analyzed: 10, candidates: 12, lapIds: [1, 2, 3] },
    style: style(),
    pace: { consistency: 88, sdS: 0.31, bestS: 92.104, meanS: 92.8, degSlopeSPerLap: 0.012, n: 10, basis: "single-context", contexts: 1 },
    weaknesses: [weakness()],
    detectors: [weakness()],
    ...over,
  };
}

const ctx = { gameName: "Forza Motorsport", carName: "Porsche 911 GT3 R", trackName: "Road Atlanta" };

// ---------------------------------------------------------------------------

describe("buildDrivingCoachPrompt — style axes", () => {
  test("renders a plain-language reading before every raw number", () => {
    const p = buildDrivingCoachPrompt({ fingerprint: fingerprint(), ...ctx });
    // 0.72 alone tells the model nothing about the scale it lives on.
    expect(p).toContain("works the tyres in a normal quick-driver range");
    expect(p).toContain("1.0 = at peak grip");
  });

  test("names the balance direction and keeps the unit", () => {
    const p = buildDrivingCoachPrompt({ fingerprint: fingerprint(), ...ctx });
    expect(p).toContain("understeer lean");
    expect(p).toContain("+2.1° front-minus-rear slip angle");
  });

  test("flags oversteer with a negative balance", () => {
    const fp = fingerprint({ style: style({ balanceMedianDeg: -5.2 }) });
    const p = buildDrivingCoachPrompt({ fingerprint: fp, ...ctx });
    expect(p).toContain("pronounced oversteer");
  });

  test("reads a median grip utilisation above 1.0 as scrubbing, not commitment", () => {
    const fp = fingerprint({ style: style({ gripUtilMedian: 1.15 }) });
    const p = buildDrivingCoachPrompt({ fingerprint: fp, ...ctx });
    expect(p).toContain("scrubbing, not commitment");
  });

  test("marks brakingStyle as relative-only so it is not read as a percentage", () => {
    const p = buildDrivingCoachPrompt({ fingerprint: fingerprint(), ...ctx });
    expect(p).toContain("RELATIVE ONLY");
    expect(p).toContain("leans early / over-slowing");
  });

  test("omits axes that could not be measured rather than printing a zero", () => {
    const fp = fingerprint({ style: style({ gripUtilMedian: null, controlLossFraction: null }) });
    const p = buildDrivingCoachPrompt({ fingerprint: fp, ...ctx });
    expect(p).not.toContain("Grip usage (median)");
    expect(p).not.toContain("Loss of control");
    // The axes that *were* measured still appear.
    expect(p).toContain("Steering variability");
  });

  test("tells the model to stay non-committal when there is no style at all", () => {
    const fp = fingerprint({ style: null });
    const p = buildDrivingCoachPrompt({ fingerprint: fp, ...ctx });
    expect(p).toContain("Not enough laps to characterise a style");
    expect(p).toContain("do not guess at a style from the fault list alone");
  });
});

describe("buildDrivingCoachPrompt — unquantified costs", () => {
  test("says 'cost not measured' and never renders a zero", () => {
    const un = weakness({ id: "driving-coasting", label: "Coasting", medianTimeLossS: null, lapsQuantified: 0, timeLossKnown: false, score: 0.5 });
    const fp = fingerprint({ weaknesses: [], unquantifiedWeaknesses: [un], detectors: [un] });
    const p = buildDrivingCoachPrompt({ fingerprint: fp, ...ctx });
    expect(p).toContain("cost not measured");
    expect(p).not.toContain("0.00 s");
  });

  test("states explicitly that not-measured is neither free nor unimportant", () => {
    const un = weakness({ medianTimeLossS: null, timeLossKnown: false });
    const fp = fingerprint({ unquantifiedWeaknesses: [un] });
    const p = buildDrivingCoachPrompt({ fingerprint: fp, ...ctx });
    expect(p).toContain(`does NOT mean "costs nothing"`);
    expect(p).toContain(`does NOT mean "less important"`);
  });

  test("falls back to the unquantified list when nothing at all was costed", () => {
    const un = weakness({ medianTimeLossS: null, timeLossKnown: false });
    const fp = fingerprint({ weaknesses: [], unquantifiedWeaknesses: [un] });
    const p = buildDrivingCoachPrompt({ fingerprint: fp, ...ctx });
    expect(p).toContain("Build `focusAreas` from the section below instead");
  });

  test("forbids summing the per-fault costs into a lap total", () => {
    const p = buildDrivingCoachPrompt({ fingerprint: fingerprint(), ...ctx });
    expect(p).toContain("NEVER add them together into a lap total");
  });
});

describe("buildDrivingCoachPrompt — pace", () => {
  test("reports seconds for a single car+track context", () => {
    const p = buildDrivingCoachPrompt({ fingerprint: fingerprint(), ...ctx });
    expect(p).toContain("Best lap: 92.104 s");
  });

  test("withholds lap times across contexts and says why", () => {
    const fp = fingerprint({
      scope: { kind: "global", gameId: "fm-2023", carOrdinal: null, trackOrdinal: null },
      pace: { consistency: 84, sdS: null, bestS: null, meanS: null, degSlopeSPerLap: null, n: 40, basis: "median-of-contexts", contexts: 7 },
    });
    const p = buildDrivingCoachPrompt({ fingerprint: fp, gameName: "Forza Motorsport" });
    expect(p).toContain("Lap times are NOT reported");
    expect(p).toContain("would be meaningless");
    expect(p).not.toContain("Best lap:");
  });
});

describe("buildDrivingCoachPrompt — guardrails", () => {
  test("pins focus areas to detector ids that exist", () => {
    const p = buildDrivingCoachPrompt({ fingerprint: fingerprint(), ...ctx });
    expect(p).toContain("id: driving-early-braking");
    expect(p).toContain("MUST be an id copied exactly from the tables above");
  });

  test("tells the model to omit estimatedGainS rather than write zero", () => {
    const p = buildDrivingCoachPrompt({ fingerprint: fingerprint(), ...ctx });
    expect(p).toContain("do not write 0");
  });

  test("keeps strength claims honest about what absence proves", () => {
    const fp = fingerprint({ strengths: [{ id: "tire-lockup-front", label: "Front lockups", perLapFrequency: 0, basis: "absent" }] });
    const p = buildDrivingCoachPrompt({ fingerprint: fp, ...ctx });
    expect(p).toContain("never absent means never detected, not proof of mastery");
  });

  test("surfaces data caveats when the aggregator recorded any", () => {
    const fp = fingerprint({ notes: ["Capped at 40 laps."] });
    const p = buildDrivingCoachPrompt({ fingerprint: fp, ...ctx });
    expect(p).toContain("DATA CAVEATS");
    expect(p).toContain("Capped at 40 laps.");
  });

  test("names the scope so the model does not generalise a car+track profile", () => {
    const p = buildDrivingCoachPrompt({ fingerprint: fingerprint(), ...ctx });
    expect(p).toContain("Porsche 911 GT3 R");
    expect(p).toContain("Road Atlanta");
  });

  test("adds a language directive only for non-English", () => {
    const en = buildDrivingCoachPrompt({ fingerprint: fingerprint(), ...ctx, language: "en" });
    const de = buildDrivingCoachPrompt({ fingerprint: fingerprint(), ...ctx, language: "de" });
    expect(en).not.toContain("Write all prose in language code");
    expect(de).toContain(`Write all prose in language code "de"`);
  });
});

describe("DriverProfileOutputSchema", () => {
  const valid = {
    summary: "You commit well but give it back under braking.",
    styleLabel: "committed, brakes early",
    strengths: [{ title: "No lockups", detail: "Never triggered a front lockup across the pool." }],
    focusAreas: [
      {
        detectorId: "driving-early-braking",
        title: "Brake later into slow corners",
        whatHappens: "You reach for the pedal well before the marker.",
        whyItCosts: "You arrive at the apex with speed in hand and no way to use it.",
        drill: "Move your brake point one board later each lap until you miss the apex, then step back one.",
        estimatedGainS: 0.25,
      },
    ],
    sessionPlan: ["Ten laps working only on brake points."],
  };

  test("accepts a well-formed plan", () => {
    expect(DriverProfileOutputSchema.safeParse(valid).success).toBe(true);
  });

  test("estimatedGainS is optional — an unquantified fault omits it entirely", () => {
    const noGain = { ...valid, focusAreas: [{ ...valid.focusAreas[0], estimatedGainS: undefined }] };
    const parsed = DriverProfileOutputSchema.safeParse(noGain);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.focusAreas[0].estimatedGainS).toBeUndefined();
  });

  test("rejects a focus area with no detectorId to pin it to", () => {
    const orphan = { ...valid, focusAreas: [{ ...valid.focusAreas[0], detectorId: undefined }] };
    expect(DriverProfileOutputSchema.safeParse(orphan).success).toBe(false);
  });

  test("parses through markdown fences and leading prose", () => {
    const wrapped = "Here you go:\n```json\n" + JSON.stringify(valid) + "\n```";
    const parsed = parseDriverProfileOutput(wrapped);
    expect(parsed.success).toBe(true);
  });

  test("fails rather than half-accepting truncated output", () => {
    expect(parseDriverProfileOutput('{"summary": "cut off').success).toBe(false);
  });
});

describe("driverProfileScopeKey", () => {
  test("distinguishes a global scope from a car+track scope", () => {
    const global = driverProfileScopeKey({ gameId: "fm-2023" });
    const scoped = driverProfileScopeKey({ gameId: "fm-2023", carOrdinal: 5, trackOrdinal: 9 });
    expect(global).not.toBe(scoped);
  });

  test("uses a sentinel rather than SQL NULL, so two global scopes collide as intended", () => {
    // SQLite treats NULLs as distinct in a UNIQUE index; if the key leaned on
    // NULL the upsert would insert a second global row instead of replacing.
    expect(driverProfileScopeKey({ gameId: "fm-2023" })).toBe("fm-2023|*|*");
    expect(driverProfileScopeKey({ gameId: "fm-2023", carOrdinal: null, trackOrdinal: null })).toBe("fm-2023|*|*");
  });

  test("separates games with otherwise identical ordinals", () => {
    expect(driverProfileScopeKey({ gameId: "fm-2023", carOrdinal: 1, trackOrdinal: 2 })).not.toBe(
      driverProfileScopeKey({ gameId: "f1-2025", carOrdinal: 1, trackOrdinal: 2 }),
    );
  });

  test("ordinal 0 is a real ordinal, not an absent one", () => {
    expect(driverProfileScopeKey({ gameId: "fm-2023", carOrdinal: 0, trackOrdinal: 0 })).toBe("fm-2023|0|0");
  });
});
