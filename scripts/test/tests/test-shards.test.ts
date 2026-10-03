import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkTestShards } from "../check-shards";

interface OwnerFixture {
  root: string;
  name?: string;
  tests?: string[];
  manifests?: Partial<Record<"unit" | "tooling" | "integration" | "e2e", string[]>>;
}

function withWorkspace(owners: OwnerFixture[], run: (root: string) => void, rootTests: string[] = []): void {
  const root = mkdtempSync(resolve(tmpdir(), "raceiq-test-shards-"));
  try {
    writeFileSync(resolve(root, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*", "apps/*"] }));
    for (const owner of owners) {
      const dir = resolve(root, owner.root);
      mkdirSync(dir, { recursive: true });
      writeFileSync(resolve(dir, "package.json"), JSON.stringify({ name: owner.name ?? `@test/${owner.root.replaceAll("/", "-")}` }));
      for (const file of owner.tests ?? []) {
        const path = resolve(dir, file);
        mkdirSync(resolve(path, ".."), { recursive: true });
        writeFileSync(path, "");
      }
      for (const [suite, files] of Object.entries(owner.manifests ?? {})) {
        const path = resolve(dir, `test/${suite}-files.txt`);
        mkdirSync(resolve(path, ".."), { recursive: true });
        writeFileSync(path, files.join("\n"));
      }
    }
    for (const file of rootTests) {
      const path = resolve(root, file);
      mkdirSync(resolve(path, ".."), { recursive: true });
      writeFileSync(path, "");
    }
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const standard = (root: string, entries: Record<string, string[]>) => ({
  root,
  tests: Object.values(entries).flat(),
  manifests: Object.fromEntries(Object.entries(entries).map(([suite, files]) => [suite, files.map((file) => `${root}/${file}`)])),
});

describe("test shard coverage", () => {
  test("accepts workspace-local tests assigned exactly once", () => {
    withWorkspace(
      [
        standard("packages/one", { unit: ["test/unit.test.ts"], tooling: ["test/tool.test.ts"] }),
        standard("apps/two", { integration: ["test/integration.test.tsx"], e2e: ["test/e2e.test.ts"] }),
      ],
      (root) => expect(checkTestShards(root)).toEqual({ testCount: 4, suiteCounts: { unit: 1, tooling: 1, integration: 1, e2e: 1 } }),
    );
  });

  test("discovers additional workspaces without owner lists", () => {
    withWorkspace(
      [standard("packages/new-game", { unit: ["test/new.test.ts"] })],
      (root) => expect(checkTestShards(root).testCount).toBe(1),
    );
  });

  test("rejects an unassigned colocated test", () => {
    withWorkspace(
      [{
        root: "packages/game",
        tests: ["test/assigned.test.ts", "test/missing.test.ts"],
        manifests: { unit: ["packages/game/test/assigned.test.ts"] },
      }],
      (root) => expect(() => checkTestShards(root)).toThrow("packages/game/test/missing.test.ts: not assigned"),
    );
  });

  test("rejects cross-owner assignment", () => {
    withWorkspace(
      [
        standard("packages/one", { unit: ["test/one.test.ts"] }),
        { root: "packages/two", tests: ["test/two.test.ts"], manifests: { unit: ["packages/one/test/one.test.ts", "packages/two/test/two.test.ts"] } },
      ],
      (root) => expect(() => checkTestShards(root)).toThrow("path must stay inside packages/two/test/") ,
    );
  });

  test("rejects traversal", () => {
    withWorkspace([{ root: "packages/game", tests: ["test/ok.test.ts"], manifests: { unit: ["../../test/ok.test.ts"] } }],
      (root) => expect(() => checkTestShards(root)).toThrow("path must stay inside packages/game/test/"));
  });

  test("rejects duplicate suite assignment", () => {
    withWorkspace([{ root: "packages/game", tests: ["test/one.test.ts"], manifests: { unit: ["packages/game/test/one.test.ts"], integration: ["packages/game/test/one.test.ts"] } }],
      (root) => expect(() => checkTestShards(root)).toThrow("listed more than once"));
  });

  test("rejects stale manifest entries", () => {
    withWorkspace([{ root: "packages/game", tests: [], manifests: { unit: ["packages/game/test/deleted.test.ts"] } }],
      (root) => expect(() => checkTestShards(root)).toThrow("listed test file does not exist"));
  });

  test("rejects present empty manifest", () => {
    withWorkspace([{ root: "packages/game", tests: ["test/one.test.ts"], manifests: { unit: [] } }],
      (root) => expect(() => checkTestShards(root)).toThrow("packages/game/test/unit-files.txt: no test files"));
  });

  test("allows absent suite manifests", () => {
    withWorkspace([standard("packages/game", { unit: ["test/one.test.ts"] })],
      (root) => expect(checkTestShards(root).suiteCounts).toEqual({ unit: 1, tooling: 0, integration: 0, e2e: 0 }));
  });

  test("rejects ordinary root tests outside owner roots", () => {
    withWorkspace([standard("packages/game", { unit: ["test/one.test.ts"] })],
      (root) => expect(() => checkTestShards(root)).toThrow("ordinary test is outside an owner test root"), ["test/orphan.test.ts"]);
  });
});
