import { describe, expect, test } from "bun:test";
import { buildTuneChatIntentPrompt } from "../server/ai/tune-intent";
import { applyIntents } from "../server/setups/rules/engine";
import { knownComponents } from "../server/setups/rules/catalog";
import type { TuneIntent } from "../server/ai/schemas";
import type { TuneSymptoms } from "../server/ai/tune-symptoms";

/**
 * Prompt-layer tests for the PRE-DRIVE "Generate setup from chat" path. Exercises
 * the pure prompt builder + the deterministic applier directly — importing the
 * composed app would bind the UDP socket (EADDRINUSE), so nothing HTTP is here.
 */
describe("buildTuneChatIntentPrompt", () => {
  const conversation = [
    "Driver: the car is loose on entry into the slow hairpin",
    "Engineer: soften the rear ARB a little to calm the rear on entry",
  ].join("\n");

  test("embeds the conversation and only the allowed component names", () => {
    const prompt = buildTuneChatIntentPrompt("acc", {
      conversation,
      currentSetupSummary: "advancedSetup.mechanicalBalance.aRBRear: 5",
      symptoms: null,
      trackName: "Spa",
    });

    // The conversation is the feel input
    expect(prompt).toContain("loose on entry into the slow hairpin");
    expect(prompt).toContain("soften the rear ARB");
    expect(prompt).toContain("Spa");
    // Allowed components are enumerated verbatim from setup rule catalog.
    for (const comp of knownComponents("acc")) {
      expect(prompt).toContain(comp);
    }
    // Current setup values are framed as evidence, never as targets
    expect(prompt).toContain("advancedSetup.mechanicalBalance.aRBRear: 5");
    expect(prompt.toLowerCase()).toContain("evidence only");
  });

  test("forbids raw setup numbers and defers clicks to the deterministic engine", () => {
    const prompt = buildTuneChatIntentPrompt("acc", {
      conversation,
      currentSetupSummary: null,
      symptoms: null,
    });
    expect(prompt.toLowerCase()).toContain("never output raw setup numbers");
    expect(prompt.toLowerCase()).toContain("deterministic engine");
    // Direction + magnitude vocabulary only
    expect(prompt).toContain("increase");
    expect(prompt).toContain("decrease");
    expect(prompt).toContain("small");
    expect(prompt).toContain("large");
  });

  test("includes the telemetry symptom report when a lap exists", () => {
    const symptoms: TuneSymptoms = {
      corners: [],
      aggregate: {
        balance: "understeer",
        understeerCorners: ["T5"],
        oversteerCorners: [],
        lockupCorners: [],
        bottomingCorners: [],
        tyrePressure: null,
        tyreTemp: null,
        damper: null,
        weightTransfer: null,
      },
    };
    const prompt = buildTuneChatIntentPrompt("acc", {
      conversation,
      currentSetupSummary: null,
      symptoms,
    });
    expect(prompt).toContain("TELEMETRY SYMPTOM REPORT");
    expect(prompt).toContain("Overall balance: understeer");
    expect(prompt).toContain("Understeer corners: T5");
  });
});

describe("applyIntents guardrail (LLM picks direction/magnitude, rules pick clicks)", () => {
  test("converts a direction+magnitude intent into a concrete clamped click value", () => {
    const setup = { advancedSetup: { mechanicalBalance: { aRBRear: 5 } } };
    const intents: TuneIntent[] = [
      { component: "Rear Anti-Roll Bar", direction: "decrease", magnitude: "medium", reason: "calm entry" },
    ];
    const { setup: next, applied, skipped } = applyIntents("acc", setup, intents);

    expect(applied).toHaveLength(1);
    // medium step = 2 clicks; 5 - 2 = 3 (the rules own the maths)
    expect(applied[0].from).toBe(5);
    expect(applied[0].to).toBe(3);
    expect(next.advancedSetup.mechanicalBalance.aRBRear).toBe(3);
    expect(skipped).toHaveLength(0);
    // Input is not mutated (pure w.r.t. caller's object)
    expect(setup.advancedSetup.mechanicalBalance.aRBRear).toBe(5);
  });

  test("skips a hallucinated component name instead of corrupting the setup", () => {
    const setup = { advancedSetup: { mechanicalBalance: { aRBRear: 5 } } };
    const intents: TuneIntent[] = [
      { component: "Warp Core Alignment", direction: "increase", magnitude: "large", reason: "nonsense" },
    ];
    const { applied, skipped } = applyIntents("acc", setup, intents);
    expect(applied).toHaveLength(0);
    expect(skipped).toHaveLength(1);
    expect(skipped[0].component).toBe("Warp Core Alignment");
  });
});
