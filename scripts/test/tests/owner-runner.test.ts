import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

test("owner suites load database preload and isolate writable paths from inherited data", () => {
  const root = mkdtempSync(resolve(tmpdir(), "raceiq-owner-runner-"));
  try {
    const inherited = resolve(root, "inherited");
    const result = resolve(root, "result.jsonl");
    mkdirSync(inherited);
    writeFileSync(resolve(inherited, "keep.txt"), "production sentinel");
    mkdirSync(resolve(root, "scripts/test"), { recursive: true });
    for (const file of ["run-suite.ts", "check-shards.ts", "owners.ts"]) {
      writeFileSync(resolve(root, "scripts/test", file), readFileSync(resolve(import.meta.dir, "..", file)));
    }
    writeFileSync(resolve(root, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
    mkdirSync(resolve(root, "packages/owner/test"), { recursive: true });
    writeFileSync(resolve(root, "packages/owner/package.json"), JSON.stringify({ name: "@fixture/owner" }));
    mkdirSync(resolve(root, "server/test-support"), { recursive: true });
    writeFileSync(resolve(root, "server/test-support/setup-data-dir.ts"), `
      import { Database } from "bun:sqlite";
      const db = new Database(process.env.DATA_DIR + "/app.db", { create: true });
      db.run("CREATE TABLE laps (id INTEGER PRIMARY KEY, time REAL)");
      db.close();
    `);
    for (const suite of ["unit", "integration"]) {
      writeFileSync(resolve(root, `packages/owner/test/${suite}-files.txt`), `packages/owner/test/${suite}.test.ts\n`);
      writeFileSync(resolve(root, `packages/owner/test/${suite}.test.ts`), `
        import { expect, test } from "bun:test";
        import { Database } from "bun:sqlite";
        import { appendFileSync, existsSync } from "node:fs";
        test("${suite} database behavior", () => {
          const path = process.env.DATA_DIR + "/app.db";
          expect(process.env.DATA_DIR).not.toBe(process.env.INHERITED_DATA_DIR);
          expect(process.env.DATA_DIR).toBe(process.env.RACEIQ_TEST_DATA_DIR);
          expect(existsSync(path)).toBe(${suite === "integration"});
          if (${suite === "integration"}) {
            const db = new Database(path);
            db.run("INSERT INTO laps (time) VALUES (88.5)");
            expect(db.query("SELECT time FROM laps").get()).toEqual({ time: 88.5 });
            db.close();
          }
          appendFileSync(process.env.RESULT_PATH!, JSON.stringify({ suite: "${suite}", dataDir: process.env.DATA_DIR }) + "\\n");
        });
      `);
    }
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
