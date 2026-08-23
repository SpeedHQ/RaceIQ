import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkTestShards } from "../../scripts/test/check-shards";

interface ShardFixture {
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
        unit: ["test/unit/example.test.ts"],
        integration: ["test/integration/example.test.tsx"],
        tests: ["test/unit/example.test.ts", "test/integration/example.test.tsx"],
      },
      (root) => {
        expect(checkTestShards(root)).toEqual({
          testCount: 2,
          shardCounts: { unit: 1, integration: 1 },
        });
      },
    );
  });

  test("rejects an ordinary test missing from both shards", () => {
    withShardFixture(
      {
        unit: ["test/unit/example.test.ts"],
        integration: ["test/integration/example.test.ts"],
        tests: ["test/unit/example.test.ts", "test/integration/example.test.ts", "test/new.test.ts"],
      },
      (root) => {
        expect(() => checkTestShards(root)).toThrow("test/new.test.ts: not assigned to a test shard");
      },
    );
  });

  test("rejects a test assigned to multiple shards", () => {
    withShardFixture(
      {
        unit: ["test/shared.test.ts"],
        integration: ["test/shared.test.ts"],
        tests: ["test/shared.test.ts"],
      },
      (root) => {
        expect(() => checkTestShards(root)).toThrow("test/shared.test.ts: listed more than once");
      },
    );
  });

  test("rejects a stale manifest entry", () => {
    withShardFixture(
      {
        unit: ["test/unit/example.test.ts"],
        integration: ["test/deleted.test.ts"],
        tests: ["test/unit/example.test.ts"],
      },
      (root) => {
        expect(() => checkTestShards(root)).toThrow("listed test file does not exist: test/deleted.test.ts");
      },
    );
  });
});
