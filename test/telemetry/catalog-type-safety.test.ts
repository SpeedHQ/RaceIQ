import { describe, expect, test } from "bun:test";

const FIXTURES = [
  "test/telemetry/catalog-type-valid.ts",
  "test/telemetry/catalog-type-invalid.ts",
];

describe("telemetry catalog type contracts", () => {
  test("valid and invalid fixtures typecheck with expected errors", () => {
    const result = Bun.spawnSync([
      "bunx",
      "tsc",
      "--noEmit",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--skipLibCheck",
      "--ignoreConfig",
      ...FIXTURES,
    ]);

    expect(result.exitCode).toBe(0);
  });
});
