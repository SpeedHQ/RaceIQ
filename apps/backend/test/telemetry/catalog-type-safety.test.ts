import { describe, expect, test } from "bun:test";

const FIXTURES = [
  "apps/backend/test/telemetry/catalog-type-valid.ts",
  "apps/backend/test/telemetry/catalog-type-invalid.ts",
];

describe("telemetry catalog type contracts", () => {
  test("valid and invalid fixtures typecheck with expected errors", () => {
    const result = Bun.spawnSync([
      "bun",
      "check",
      "--no-pretty",
      "--strict",
      "--target",
      "ES2022",
      "--module",
      "ESNext",
      "--moduleResolution",
      "bundler",
      "--skipLibCheck",
      ...FIXTURES,
    ]);

    expect(result.exitCode).toBe(0);
  });
});
