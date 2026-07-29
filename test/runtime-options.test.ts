import { describe, expect, test } from "bun:test";
import {
  getOnboardingOverride,
  parseOnboardingOverride,
  withOnboardingOverride,
} from "../server/runtime-options";

describe("server onboarding runtime option", () => {
  test("parses spaced and inline boolean values", () => {
    expect(parseOnboardingOverride(["--onboarding", "false"])).toBe(false);
    expect(parseOnboardingOverride(["--onboarding=true"])).toBe(true);
    expect(parseOnboardingOverride([])).toBeNull();
  });

  test("rejects missing and invalid values", () => {
    expect(() => parseOnboardingOverride(["--onboarding"])).toThrow(
      "--onboarding must be followed by true or false",
    );
    expect(() => parseOnboardingOverride(["--onboarding", "sometimes"])).toThrow(
      "--onboarding must be followed by true or false",
    );
  });

  test("ignores the option outside development", () => {
    expect(getOnboardingOverride(["--onboarding", "false"], false)).toBeNull();
  });

  test("overrides client settings without mutating persisted values", () => {
    const persistedIncomplete = { onboardingComplete: false, driverName: "" };
    const skipped = withOnboardingOverride(persistedIncomplete, false);

    expect(skipped).toEqual({ onboardingComplete: true, driverName: "" });
    expect(persistedIncomplete.onboardingComplete).toBe(false);

    const persistedComplete = { onboardingComplete: true, driverName: "Driver" };
    const forced = withOnboardingOverride(persistedComplete, true);

    expect(forced).toEqual({ onboardingComplete: false, driverName: "Driver" });
    expect(persistedComplete.onboardingComplete).toBe(true);
    expect(withOnboardingOverride(persistedComplete, null)).toBe(persistedComplete);
  });
});
