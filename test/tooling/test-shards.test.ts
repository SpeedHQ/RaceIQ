import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkTestShards } from "../../scripts/test/check-shards";

interface ShardFixture {
  e2e: string[];
  integration: string[];
  tests: string[];
  unit: string[];
}

function withShardFixture(fixture: ShardFixture, run: (root: string) => void): void {
  const root = mkdtempSync(resolve(tmpdir(), "raceiq-test-shards-"));
  try {
    mkdirSync(resolve(root, "scripts/test"), { recursive: true });
    writeFileSync(resolve(root, "scripts/test/unit-files.txt"), fixture.unit.join("\n"));
    writeFileSync(resolve(root, "scripts/test/integration-files.txt"), fixture.integration.join("\n"));
    writeFileSync(resolve(root, "scripts/test/e2e-files.txt"), fixture.e2e.join("\n"));
    for (const file of fixture.tests) {
      const path = resolve(root, file);
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, "");
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("test shard coverage", () => {
  test("accepts every ordinary test assigned exactly once", () => {
    withShardFixture(
      {
        e2e: ["test/e2e/example.test.ts"],
        unit: ["test/unit/example.test.ts"],
        integration: ["test/integration/example.test.tsx"],
        tests: ["test/unit/example.test.ts", "test/integration/example.test.tsx", "test/e2e/example.test.ts"],
      },
      (root) => {
        expect(checkTestShards(root)).toEqual({
          testCount: 3,
          suiteCounts: { unit: 1, integration: 1, e2e: 1 },
        });
      },
    );
  });
  test("rejects an ordinary test missing from all suites", () => {
    withShardFixture(
      {
        e2e: ["test/e2e/example.test.ts"],
        unit: ["test/unit/example.test.ts"],
        integration: ["test/integration/example.test.ts"],
        tests: ["test/unit/example.test.ts", "test/integration/example.test.ts", "test/e2e/example.test.ts", "test/new.test.ts"],
      },
      (root) => {
        expect(() => checkTestShards(root)).toThrow("test/new.test.ts: not assigned to a test suite");
      },
    );
  });

  test("rejects a test assigned to multiple suites", () => {
    withShardFixture(
      {
        e2e: ["test/shared.test.ts"],
        unit: ["test/shared.test.ts"],
        integration: ["test/integration/example.test.ts"],
        tests: ["test/shared.test.ts", "test/e2e/example.test.ts", "test/integration/example.test.ts"],
      },
      (root) => {
        expect(() => checkTestShards(root)).toThrow("test/shared.test.ts: listed more than once");
      },
    );
  });

  test("rejects a stale manifest entry", () => {
    withShardFixture(
      {
        e2e: ["test/e2e/example.test.ts"],
        unit: ["test/unit/example.test.ts"],
        integration: ["test/deleted.test.ts"],
        tests: ["test/unit/example.test.ts", "test/e2e/example.test.ts"],
      },
      (root) => {
        expect(() => checkTestShards(root)).toThrow("listed test file does not exist: test/deleted.test.ts");
      },
    );
  });
});
