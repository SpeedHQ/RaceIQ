/**
 * Pure/query-level tests for the Setup Engineer tools' grounding mechanism
 * (docs/setup-engineer-tools-plan.md §3, Phase 2).
 *
 * Deliberately does NOT import the composed app (server/index.ts) or
 * `mastra/tools/setup-engineer.ts` itself — the tool file wires DB/fs/memory
 * side effects via `loadActiveTuningContext`/`writeSetupFile`/`createTuningTest`,
 * none of which are worth mocking here. Instead this exercises the same
 * primitives the tools are built on directly:
 *   - `describeKnobs` — what `get_current_setup` returns.
 *   - `applyIntents` on a clone — what `preview_change` runs (read-only).
 *   - a zod enum built from `knownComponents` — the grounding mechanism that
 *     makes an unlisted component a schema-validation failure, not just a
 *     silently-skipped intent.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { applyIntents, describeKnobs, knownComponents } from "../server/ai/tune-rules";

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

/** Mirrors `componentEnum()` in mastra/tools/setup-engineer.ts. */
function componentEnum(gameId: "acc" | "ac-evo") {
  const names = knownComponents(gameId);
  return names.length > 0 ? z.enum(names as [string, ...string[]]) : z.enum(["none"] as [string, ...string[]]);
}

describe("describeKnobs — get_current_setup grounding", () => {
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
    // f1-2025 has no RULES entry in tune-rules.ts.
    expect(describeKnobs("f1-2025" as any, {})).toEqual([]);
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

describe("component enum grounding — the ONLY action space the agent can name", () => {
  test("a known component parses", () => {
    const schema = componentEnum("acc");
    expect(schema.safeParse("Diff Preload").success).toBe(true);
  });

  test("an unlisted/hallucinated component fails validation before applyIntents ever runs", () => {
    const schema = componentEnum("acc");
    const result = schema.safeParse("Front Anti-Roll Bar Stiffness Coefficient");
    expect(result.success).toBe(false);
  });

  test("a component that exists for the other game is rejected for this one", () => {
    // Ride height / dampers are ACC-only (unverified AC-Evo snapshot shape).
    const schema = componentEnum("ac-evo");
    expect(schema.safeParse("Front Ride Height").success).toBe(false);
    expect(schema.safeParse("Front Anti-Roll Bar").success).toBe(true);
  });
});
