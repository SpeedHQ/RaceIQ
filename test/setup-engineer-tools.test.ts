/**
 * Pure/query-level tests for the Setup Engineer tools' grounding mechanism
 * (docs/setup-engineer-tools-plan.md §3, Phase 2).
 *
 * Deliberately does NOT import the composed app (server/index.ts) or
 * `mastra/tools/setup-engineer.ts` itself — the tool file wires DB/fs/memory
 * side effects via `loadActiveExperimentContext`/`writeSetupFile`/`createExperimentVersion`,
 * none of which are worth mocking here. Instead this exercises the same
 * primitives the tools are built on directly:
 *   - `describeKnobs` — what `get_setup` returns.
 *   - `applyIntents` on a clone — what `preview_change` runs (read-only).
 *   - a zod enum built from `knownComponents` — the grounding mechanism that
 *     makes an unlisted component a schema-validation failure, not just a
 *     silently-skipped intent.
 */
import { describe, expect, test } from "bun:test";
import { applyIntents, describeKnobs, knownComponents } from "../server/ai/tune-rules";
import { readSetupEngineerContext } from "../mastra/tools/setup-engineer-request-context";

function baseAccSetup() {
  return {
    basicSetup: {
      tyres: { tyrePressure: [26, 26, 26, 26] },
    },
    advancedSetup: {
      mechanicalBalance: { aRBFront: 5, aRBRear: 5, brakeBias: 55 },
      aeroBalance: { splitter: 3, rearWing: 4, rideHeight: [65, 65, 75, 75] },
      dampers: { bumpSlow: [8, 8, 8, 8], reboundSlow: [8, 8, 8, 8] },
      drivetrain: { preload: 40 },
    },
  };
}

describe("describeKnobs — get_setup grounding", () => {
  test("returns every known component with current value, range, and step", () => {
    const setup = baseAccSetup();
    const knobs = describeKnobs("acc", setup);
    const names = knobs.map((k) => k.component);

    expect(names.sort()).toEqual(knownComponents("acc").sort());

    const arb = knobs.find((k) => k.component === "Front Anti-Roll Bar")!;
    expect(arb.current).toBe(5);
    expect(arb.min).toBe(0);
    expect(arb.max).toBe(30);
    expect(arb.step).toEqual({ small: 1, medium: 2, large: 4 });

    const preload = knobs.find((k) => k.component === "Diff Preload")!;
    expect(preload.current).toBe(40);
    expect(preload.step.medium).toBe(2);
  });

  test("returns [] for a game with no rules table", () => {
    // "gt7" has no RULES entry in tune-rules.ts.
    expect(describeKnobs("gt7" as any, {})).toEqual([]);
  });

  test("f1-2025 has a RULES table sourced from the catalog (Phase 10)", () => {
    const knobs = describeKnobs("f1-2025", {});
    const names = knobs.map((k) => k.component);
    expect(names.sort()).toEqual(knownComponents("f1-2025").sort());

    const wing = knobs.find((k) => k.component === "Front Wing")!;
    expect(wing.min).toBe(0);
    expect(wing.max).toBe(50);
    expect(wing.current).toBeNull();
  });

  test("current is null when the setup is missing the field", () => {
    const knobs = describeKnobs("acc", {});
    const arb = knobs.find((k) => k.component === "Front Anti-Roll Bar")!;
    expect(arb.current).toBeNull();
  });
});

describe("preview_change semantics — applyIntents on a clone, never mutating the input", () => {
  test("returns the real clamped resulting value without touching the source setup", () => {
    const setup = baseAccSetup();
    const { applied, skipped } = applyIntents("acc", setup, [
      { component: "Front Anti-Roll Bar", direction: "increase", magnitude: "medium", reason: "preview" },
    ]);

    expect(skipped).toHaveLength(0);
    expect(applied[0]!.from).toBe(5);
    expect(applied[0]!.to).toBe(7);
    // Source object passed in is untouched — preview_change must never persist.
    expect(setup.advancedSetup.mechanicalBalance.aRBFront).toBe(5);
  });

  test("reports noop with a reason when the knob is already at its clamp limit", () => {
    const setup = baseAccSetup();
    setup.advancedSetup.mechanicalBalance.aRBFront = 30; // at max
    const { applied, skipped } = applyIntents("acc", setup, [
      { component: "Front Anti-Roll Bar", direction: "increase", magnitude: "small", reason: "preview" },
    ]);

    expect(applied).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toMatch(/clamp/i);
  });
});

describe("component grounding — the engine is the guard, not the schema", () => {
  // preview_change / apply_changes now accept `component: z.string()` (a static
  // tool's schema can't vary per game). The deterministic engine — applyIntents
  // — is what rejects an unknown component: it lands in `skipped` with a reason
  // and is never applied. This is the contract that replaced the per-game enum.
  test("a known component is applied", () => {
    const { applied, skipped } = applyIntents("acc", baseAccSetup(), [
      { component: "Diff Preload", direction: "increase", magnitude: "small", reason: "t" },
    ]);
    expect(applied.map((a) => a.component)).toContain("Diff Preload");
    expect(skipped.map((s) => s.component)).not.toContain("Diff Preload");
  });

  test("an unknown/hallucinated component is skipped with a reason, never applied", () => {
    const { applied, skipped } = applyIntents("acc", baseAccSetup(), [
      { component: "Front Anti-Roll Bar Stiffness Coefficient", direction: "increase", magnitude: "small", reason: "t" },
    ]);
    expect(applied).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]!.reason).toBeTruthy();
  });
});

describe("readSetupEngineerContext — per-request gameId/sessionId guard", () => {
  const ctx = (entries: Record<string, unknown>) => ({ get: (k: string) => entries[k] });

  test("returns { gameId, sessionId } from a Map-like request context", () => {
    expect(readSetupEngineerContext(ctx({ gameId: "acc", sessionId: 61 }))).toEqual({
      gameId: "acc",
      sessionId: 61,
    });
  });

  test("throws when the context is missing", () => {
    expect(() => readSetupEngineerContext(undefined)).toThrow(/requestContext/);
  });

  test("throws when sessionId is absent or not a number", () => {
    expect(() => readSetupEngineerContext(ctx({ gameId: "acc" }))).toThrow();
    expect(() => readSetupEngineerContext(ctx({ gameId: "acc", sessionId: "61" }))).toThrow();
  });

  test("throws when gameId is absent", () => {
    expect(() => readSetupEngineerContext(ctx({ sessionId: 61 }))).toThrow();
  });
});
