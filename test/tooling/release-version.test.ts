import { describe, expect, test } from "bun:test";
import { computeNextReleaseVersion } from "../../scripts/ci/release-version";

describe("computeNextReleaseVersion", () => {
  test("bumps latest release tag instead of package.json version", () => {
    expect(computeNextReleaseVersion(["v0.13.0", "v0.15.0"], "patch")).toBe("0.15.1");
  });

  test("skips already released versions after latest tag", () => {
    expect(computeNextReleaseVersion(["v0.13.0", "v0.15.0", "v0.15.1"], "patch")).toBe("0.15.2");
  });

  test("ignores non-release tags", () => {
    expect(computeNextReleaseVersion(["draft", "v0.15.0-rc.1", "v0.15.0"], "minor")).toBe("0.16.0");
  });
});
