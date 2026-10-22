import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseCarSetup } from "@raceiq/game-ac-evo/carsetup-wire";
import { carSetupToKnobValues } from "@raceiq/game-ac-evo/carsetup";
import { getSetupCapabilities } from "@raceiq/backend-core/setups/rules/catalog";
import { sanitizeAnalystOutput, validateSetupRecommendations } from "@raceiq/backend-core/ai/schemas";
import { setupContextForLap } from "../../src/ai/lap-setup-context";
import type { GameAdapter } from "@raceiq/shared/games/types";

const fixturePath = resolve(import.meta.dir, "../../../../test/artifacts/carsetup/Default-12312.carsetup");
const gameId = "ac-evo" as const;
const carModel = "audi_r8_lms_gt3_evo_2";
const item = (component: string, target: string, direction: "increase" | "decrease" = "increase") => ({
  component, symptom: "fixture regression", fix: "test only", current: "model invented", target, direction,
});
const full = (setup: unknown) => ({ verdict: "fixture", pace: [], handling: [], corners: [], technique: [], setup });

describe("AC EVO setup recommendation validation", () => {
  test("generated Ferrari F2004 context validates supported Front Wing recommendation", () => {
    const context = setupContextForLap({
      id: 1, gameId, carId: "88", telemetry: [],
    }, (() => ({
      getCarName: () => "ferrari_f2004",
      getTrackName: () => "",
    }) as unknown as GameAdapter), {
      id: 1, gameId, carId: "88", trackId: null,
      settings: { frontWing: 10, rearWing: 10 },
    });
    expect(context.setupSnapshot).toMatchObject({ frontWing: 10, rearWing: 10 });
    expect(validateSetupRecommendations([item("Front Wing", "11 clicks", "increase")], context)[0]?.current).toBe("10 clicks");
    expect(validateSetupRecommendations([item("Engine Map", "2 clicks")], context)).toEqual([]);
  });
  test("Audi capability fixture rejects fixed controls, illegal targets, off-step, no-op, and missing current data", () => {
    const parsedSetup = parseCarSetup(readFileSync(fixturePath));
    expect(parsedSetup).not.toBeNull();
    const snapshot: Record<string, number> = { ...carSetupToKnobValues(parsedSetup!), frontARB: 2, rearARB: 2, diffPreload: 50, frontRideHeight: 60 };
    const context = { gameId, carModel, setupSnapshot: snapshot };
    const capabilities = getSetupCapabilities(gameId, carModel);
    expect(capabilities.find((c) => c.control === "diffPower")?.status).toBe("fixed");
    expect(capabilities.find((c) => c.control === "frontRideHeight")).toMatchObject({
      status: "adjustable", unit: "mm", min: 54, max: 70, step: 1,
    });
    expect(capabilities.find((c) => c.control === "engineMap")?.status).toBe("unavailable");
    expect(snapshot.frontLeftBump).not.toBe(snapshot.frontRightBump);
    const leftCurrent = snapshot.frontLeftBump!;
    const leftDirection = leftCurrent > 1 ? "decrease" as const : "increase" as const;
    const leftTarget = leftCurrent > 1 ? leftCurrent - 1 : leftCurrent + 1;
    const leftRecommendation = validateSetupRecommendations([
      item("Front Left Slow Bump", `${leftTarget} clicks`, leftDirection),
    ], context);
    expect(leftRecommendation[0]?.current).toBe(`${leftCurrent} clicks`);
    expect(validateSetupRecommendations([
      item("Diff power", "0.25"),
      item("Diff coast", "0.25"),
      item("Diff Preload", "40 Nm", "decrease"),
      item("Front Ride Height", "53 mm", "decrease"),
      item("Front Anti-Roll Bar", "2.5 clicks"),
      item("Front Anti-Roll Bar", "2 clicks"),
      { ...item("Front Anti-Roll Bar", "2 clicks"), direction: "adjust" },
      item("Front Ride Height", "55 mm", "decrease"),
    ], context).map((r) => r.component)).toEqual(["Front Ride Height"]);

    expect(validateSetupRecommendations([item("Front Ride Height", "55 mm")], {
      gameId, carModel,
    })).toEqual([]);
  });

  test("unknown Audi range identity cannot inherit generic numeric limits", () => {
    expect(validateSetupRecommendations([item("Front Anti-Roll Bar", "3 clicks")], {
      gameId, carModel: "unknown car", setupSnapshot: { frontARB: 2 },
    })).toEqual([]);
  });
  test("sanitizes model current values and unavailable controls against parsed snapshot", () => {
    const snapshot = { frontARB: 2, rearARB: 2 };
    const clean = sanitizeAnalystOutput(full([
      { ...item("Front Anti-Roll Bar", "3 clicks"), fix: "Decrease the invented current value from 3 to 1 clicks" },
      item("Rear Anti-Roll Bar", "3 clicks"),
      item("Diff power", "0.5"),
    ]), { gameId, carModel, setupSnapshot: snapshot });
    expect(clean.success).toBe(true);
    expect(clean.success && clean.data.setup.map((r) => r.current)).toEqual(["2 clicks", "2 clicks"]);
    expect(clean.success && clean.data.setup[0].fix.includes("1 clicks")).toBe(false);
    expect(clean.success && clean.data.setup[0].fix.includes("2 clicks")).toBe(true);
  });

  test("drops recommendations from cached analysis with different lap/setup provenance", () => {
    const stale: Record<string, unknown> = full([item("Front Anti-Roll Bar", "3 clicks")]);
    stale.setupProvenance = {
      gameId, carModel, trackName: "Spa", setupVersion: "old-snapshot", lapId: 6,
    };
    const result = sanitizeAnalystOutput(stale, {
      gameId, carModel, trackName: "Monza", setupVersion: "current-snapshot", lapId: 7,
      setupSnapshot: { frontARB: 2 },
    }, { requireMatchingProvenance: true });
    expect(result.success && result.data.setup).toEqual([]);
    expect(result.success && result.data.setupProvenance?.trackName).toBe("Monza");
  });

  test("malformed cached recommendations cannot survive sanitization", () => {
    const clean = sanitizeAnalystOutput(full([{
      component: "Front Anti-Roll Bar", symptom: "x", fix: "x", current: "2", target: "NaN", direction: "increase",
    }]), { gameId, carModel, setupSnapshot: { frontARB: 2 } });
    expect(clean.success).toBe(true);
    expect(clean.success && clean.data.setup).toEqual([]);
  });
});
