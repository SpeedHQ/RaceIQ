import { describe, expect, test } from "bun:test";
import {
  buildTuneChatSystemPrompt,
  summariseSetupJson,
  type TuneChatTest,
} from "../server/ai/tune-chat-prompt";
import type { TuneSymptoms } from "../server/ai/tune-symptoms";

/**
 * Prompt-layer tests for the experiment setup chat (plan Phase D). Exercises
 * the pure prompt/summary builders directly — importing the composed app would
 * bind the UDP socket (EADDRINUSE), so nothing HTTP is touched here.
 */
describe("summariseSetupJson", () => {
  test("returns null for non-object input", () => {
    expect(summariseSetupJson(null)).toBeNull();
    expect(summariseSetupJson("nope")).toBeNull();
    expect(summariseSetupJson(42)).toBeNull();
  });

  test("flattens nested numeric/boolean/short-array leaves to path:value lines", () => {
    const out = summariseSetupJson({
      basicSetup: { tyres: { tyrePressure: [26, 26, 25, 25] }, alignment: { camber: [-3, -3] } },
      advancedSetup: { mechanicalBalance: { aRBFront: 5, aRBRear: 3 } },
      enabled: true,
    });
    expect(out).toContain("basicSetup.tyres.tyrePressure: [26, 26, 25, 25]");
    expect(out).toContain("advancedSetup.mechanicalBalance.aRBFront: 5");
    expect(out).toContain("enabled: true");
  });

  test("caps output and notes how many values were omitted", () => {
    const big: Record<string, number> = {};
    for (let i = 0; i < 100; i++) big[`k${i}`] = i;
    const out = summariseSetupJson(big, 10);
    expect(out).not.toBeNull();
    expect(out!.split("\n").length).toBe(11); // 10 values + the "… omitted" note
    expect(out).toContain("more values omitted");
  });
});

describe("buildTuneChatSystemPrompt", () => {
  const symptoms: TuneSymptoms = {
    corners: [
      {
        index: 1,
        label: "T1",
        speedBand: "slow",
        phases: [
          { phase: "entry", balance: "oversteer", balanceMagnitude: -0.05, brakeLockup: false, bottoming: false },
          { phase: "mid", balance: "neutral", balanceMagnitude: 0, brakeLockup: false, bottoming: false },
          { phase: "exit", balance: "understeer", balanceMagnitude: 0.05, brakeLockup: false, bottoming: false },
        ],
      },
    ],
    aggregate: {
      balance: "oversteer",
      understeerCorners: [],
      oversteerCorners: ["T1"],
      lockupCorners: [],
      bottomingCorners: [],
      tyrePressure: null,
      tyreTemp: null,
      damper: null,
      weightTransfer: null,
    },
  };

  const tests: TuneChatTest[] = [
    { version: 1, label: "base", appliedChanges: null, driverComment: null, engine: null },
    {
      version: 2,
      label: "Front ARB -1",
      appliedChanges: JSON.stringify([
        { component: "frontARB", from: 5, to: 4, direction: "decrease", reason: "reduce entry oversteer" },
      ]),
      driverComment: "loose on entry",
      engine: "rules",
    },
  ];

  test("includes car+track identity, symptoms, setup summary, and version history", () => {
    const prompt = buildTuneChatSystemPrompt({
      gameId: "acc",
      session: { name: "Spa GT3", carName: "Ferrari 296 GT3", trackName: "Spa" },
      tests,
      symptoms,
      currentSetupSummary: "basicSetup.tyres.tyrePressure: [26, 26, 25, 25]",
    });

    // Identity
    expect(prompt).toContain("Ferrari 296 GT3");
    expect(prompt).toContain("Spa");
    expect(prompt).toContain("ACC");
    // Symptom report
    expect(prompt).toContain("Overall balance: oversteer");
    expect(prompt).toContain("Oversteer corners: T1");
    // Setup summary
    expect(prompt).toContain("basicSetup.tyres.tyrePressure");
    // Applied-change history across versions
    expect(prompt).toContain("base:");
    expect(prompt).toContain("frontARB 5→4");
    expect(prompt).toContain('driver: "loose on entry"');
    // The deterministic-owns-the-numbers guardrail (parity §4d)
    expect(prompt.toLowerCase()).toContain("deterministic engine");
    // Forbids fabricating lap ids / lap comparisons (there is no such feature)
    expect(prompt.toLowerCase()).toContain("never invent lap ids");
    expect(prompt.toLowerCase()).toContain("lap-comparison");
    // Current setup values framed as evidence, not prescription
    expect(prompt.toLowerCase()).toContain("evidence");
    // Points the driver at the Generate setup button (pre-drive apply)
    expect(prompt).toContain("Generate setup");
  });

  test("degrades gracefully with no symptoms and no setup summary", () => {
    const prompt = buildTuneChatSystemPrompt({
      gameId: "ac-evo",
      session: { name: "Test", carName: null, trackName: null },
      tests: [],
      symptoms: null,
      currentSetupSummary: null,
    });
    expect(prompt).toContain("no analysable lap yet");
    expect(prompt).toContain("no setup file available");
    expect(prompt).toContain("(no setup versions yet)");
  });
});
