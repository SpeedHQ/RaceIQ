import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("owner suites isolate paths without loading backend database setup", () => {
  const root = mkdtempSync(resolve(tmpdir(), "raceiq-owner-runner-"));
  try {
    const inherited = resolve(root, "inherited");
    const result = resolve(root, "result.jsonl");
    mkdirSync(inherited);
    writeFileSync(resolve(inherited, "keep.txt"), "production sentinel");
    mkdirSync(resolve(root, "scripts/test"), { recursive: true });
    for (const file of ["run-suite.ts", "check-shards.ts", "owners.ts", "setup-isolated-data-dir.ts"]) {
      writeFileSync(resolve(root, "scripts/test", file), readFileSync(resolve(import.meta.dir, "..", file)));
    }
    writeFileSync(resolve(root, ".env.development"), "");
    writeFileSync(resolve(root, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
    mkdirSync(resolve(root, "packages/owner/test"), { recursive: true });
    writeFileSync(resolve(root, "packages/owner/package.json"), JSON.stringify({ name: "@fixture/owner" }));
    mkdirSync(resolve(root, "server/test-support"), { recursive: true });
    writeFileSync(resolve(root, "server/test-support/setup-data-dir.ts"), `
      import { writeFileSync } from "node:fs";
      writeFileSync(process.env.DATA_DIR + "/backend-setup-ran", "");
    `);
    for (const suite of ["unit", "integration"]) {
      writeFileSync(resolve(root, `packages/owner/test/${suite}.test.ts`), `
        import { expect, test } from "bun:test";
        import { appendFileSync, existsSync } from "node:fs";
        test("${suite} isolated data behavior", () => {
          const path = process.env.DATA_DIR + "/app.db";
          expect(process.env.DATA_DIR).not.toBe(process.env.INHERITED_DATA_DIR);
          expect(process.env.DATA_DIR).toBe(process.env.RACEIQ_TEST_DATA_DIR);
          expect(existsSync(path)).toBe(false);
          expect(existsSync(process.env.DATA_DIR + "/settings.json")).toBe(${suite === "integration"});
          expect(existsSync(process.env.DATA_DIR + "/backend-setup-ran")).toBe(false);
          appendFileSync(process.env.RESULT_PATH!, JSON.stringify({ suite: "${suite}", dataDir: process.env.DATA_DIR }) + "\\n");
        });
      `);
    }
    writeFileSync(resolve(root, "packages/owner/test/unit-files.txt"), "packages/owner/test/unit.test.ts\n");
    writeFileSync(resolve(root, "packages/owner/test/integration-files.txt"), "packages/owner/test/integration.test.ts\n");
    const child = Bun.spawnSync([process.execPath, "scripts/test/run-suite.ts", "all", "--package", "@fixture/owner"], {
      cwd: root,
      env: { ...process.env, DATA_DIR: inherited, RACEIQ_TEST_DATA_DIR: inherited, INHERITED_DATA_DIR: inherited, RESULT_PATH: result },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(child.exitCode, child.stdout.toString() + child.stderr.toString()).toBe(0);
    const rows = readFileSync(result, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { suite: string; dataDir: string });
    expect(rows.map((row) => row.suite)).toEqual(["unit", "integration"]);
    expect(rows[0]!.dataDir).not.toBe(rows[1]!.dataDir);
    for (const row of rows) expect(existsSync(row.dataDir)).toBe(false);
    expect(readFileSync(resolve(inherited, "keep.txt"), "utf8")).toBe("production sentinel");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
