import { describe, expect, test } from "bun:test";
import { releaseCompileArgs } from "../../scripts/build/compile-release";

describe("releaseCompileArgs", () => {
  test("preserves JavaScript string literals without shell quoting", () => {
    expect(releaseCompileArgs("0.15.1")).toEqual([
      "bun",
      "build",
      "--compile",
      "--target=bun-windows-x64",
      "--windows-icon=assets/raceiq.ico",
      "--windows-title=RaceIQ",
      "--windows-publisher=SpeedHQ",
      "--windows-description=RaceIQ",
      "--windows-version=0.15.1",
      "--define",
      'process.env.NODE_ENV="production"',
      "--define",
      'process.env.RACEIQ_FEATURE_F1_EXPERIMENTS="false"',
      "--define",
      'process.env.RACEIQ_FEATURE_IRACING_ADAPTER="false"',
      "server/bootstrap.ts",
      "--outfile",
      "dist/raceiq.exe",
    ]);
  });

  test("rejects a malformed release version", () => {
    expect(() => releaseCompileArgs("v0.15.1")).toThrow("Release version must match MAJOR.MINOR.PATCH: v0.15.1");
  });
});
