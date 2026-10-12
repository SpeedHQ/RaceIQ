import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../../..");
const prohibited = [
  ["static imports", 'import { Database } from "bun:sqlite"; void Database;'],
  ["re-exports", 'export { Database } from "bun:sqlite";'],
  ["dynamic imports", 'void import("bun:sqlite");'],
  ["CommonJS require", 'void require("bun:sqlite");'],
  ["module.require", 'void module.require("bun:sqlite");'],
] as const;

function lint(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-sqlite-lint-"));
  try {
    const path = join(directory, "fixture.ts");
    writeFileSync(path, source);
    const result = Bun.spawnSync([process.execPath, "x", "--no-install", "oxlint", "--config", join(root, ".oxlintrc.json"), path], { cwd: join(root, "client"), stdout: "pipe", stderr: "pipe" });
    return { code: result.exitCode, output: `${result.stdout.toString()}\n${result.stderr.toString()}` };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe("SQLite import restriction", () => {
  for (const [kind, source] of prohibited) {
    test(`rejects bun:sqlite ${kind}`, () => {
      const result = lint(source);
      expect(result.code, result.output).toBe(1);
      expect(result.output).toContain("bun:sqlite");
      expect(result.output).toContain(kind === "CommonJS require" || kind === "module.require" ? "no-bun-sqlite-require" : "no-restricted-imports");
    });
  }

  test("allows the shared SQLite driver", () => {
    const result = lint('import Database from "libsql"; import { createClient } from "@libsql/client/sqlite3"; void Database; void createClient;');
    expect(result.code, result.output).toBe(0);
  });
});
