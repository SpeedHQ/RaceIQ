import { describe, expect, test } from "bun:test";
import { releaseFeatureFlags } from "../shared/release-feature-flags";

describe("release feature flags", () => {
  test("enables unfinished integrations in development", () => {
    expect(releaseFeatureFlags(true)).toEqual({
      f1Experiments: true,
      iracingAdapter: true,
    });
  });

  test("disables unfinished integrations in production", () => {
    expect(releaseFeatureFlags(false)).toEqual({
      f1Experiments: false,
      iracingAdapter: false,
    });
  });
});
