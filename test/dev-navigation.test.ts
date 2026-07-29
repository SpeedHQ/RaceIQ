import { describe, expect, test } from "bun:test";
import {
  DEV_ONBOARDING_COMPLETE_KEY,
  enableDevOnboardingCompletion,
  hasDevOnboardingCompletion,
  normalizeDevTarget,
  withDevOnboardingCompletion,
} from "../client/src/lib/dev-navigation";

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("development navigation", () => {
  test("keeps local paths, searches, and hashes", () => {
    expect(normalizeDevTarget("/iracing/cars")).toBe("/iracing/cars");
    expect(normalizeDevTarget("/iracing/tracks?tab=map#details")).toBe("/iracing/tracks?tab=map#details");
  });

  test("rejects external and recursive targets", () => {
    expect(normalizeDevTarget("https://example.com")).toBe("/");
    expect(normalizeDevTarget("//example.com")).toBe("/");
    expect(normalizeDevTarget("/dev/open?to=/iracing/cars")).toBe("/");
    expect(normalizeDevTarget(undefined)).toBe("/");
  });

  test("spoofs completed onboarding only in development after the handler enables it", () => {
    const storage = createStorage();
    const incompleteSettings = { onboardingComplete: false, driverName: "" };

    expect(hasDevOnboardingCompletion(true, storage)).toBe(false);
    expect(withDevOnboardingCompletion(incompleteSettings, true, storage)).toBe(incompleteSettings);

    enableDevOnboardingCompletion(storage);

    expect(storage.getItem(DEV_ONBOARDING_COMPLETE_KEY)).toBe("1");
    expect(hasDevOnboardingCompletion(true, storage)).toBe(true);
    expect(withDevOnboardingCompletion(incompleteSettings, true, storage)).toEqual({
      onboardingComplete: true,
      driverName: "",
    });
    expect(withDevOnboardingCompletion(incompleteSettings, false, storage)).toBe(incompleteSettings);
    expect(incompleteSettings.onboardingComplete).toBe(false);
  });
});
