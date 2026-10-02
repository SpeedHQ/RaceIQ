import { describe, expect, test } from "bun:test";
import { fetchReleases } from "../../server/runtime/update/check";

describe("GitHub release body integration", () => {
  test.skipIf(process.env.RUN_GITHUB_RELEASE_INTEGRATION !== "1")(
    "loads bodies from v0.12.1 through released v0.14.0",
    async () => {
      const result = await fetchReleases("0.12.1");
      const v013 = result.newReleases.find((release) => release.version === "0.13.0");
      const v014 = result.newReleases.find((release) => release.version === "0.14.0");

      expect(result.currentReleaseNotes).toContain("capture AI chat errors");
      expect(v013?.notes).toContain("label Power and Torque rows separately");
      expect(v014?.notes).toContain("Analyze recent driving trends");
    },
  );
});
