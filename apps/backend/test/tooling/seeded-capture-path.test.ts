import { expect, test } from "bun:test";
import { resolve } from "node:path";

function checkPaths(assertions: string) {
  // Playwright support is a separate workspace; check its contract through Bun.
  const source = `
    import assert from "node:assert/strict";
    import { DEFAULT_GAMES, FIXTURES, LMU_MULTIPLAYER_FIXTURE_PARTS, LMU_OPPONENT_COLD_LOAD_FIXTURE_PARTS } from "./packages/tooling-data/src/data/seed-db-options";
    import { portableCapturePath } from "./playwright/support/server/seeded-database";
    ${assertions}
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", source], {
    cwd: resolve(import.meta.dir, "../../../.."), env: process.env, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
}

test("demo seed defaults retain the full LMU multiplayer recording", () => {
  checkPaths(`
    assert.deepEqual(FIXTURES.lmu, LMU_MULTIPLAYER_FIXTURE_PARTS);
    assert.notDeepEqual(FIXTURES.lmu, LMU_OPPONENT_COLD_LOAD_FIXTURE_PARTS);
  `);
});

test("portable seed paths accept every default game and normalize Windows separators", () => {
  checkPaths(`
    for (const game of DEFAULT_GAMES) {
      const own = "sessions/" + game + "/own/capture.bin";
      assert.equal(portableCapturePath(own.replaceAll("/", String.fromCharCode(92))), own);
      const others = "sessions/" + game + "/others/capture.bin.gz";
      assert.equal(portableCapturePath(others), others);
    }
  `);
});

test("portable seed paths accept LMU capture manifests", () => {
  checkPaths(`
    const manifest = "sessions/lmu/own/bundle-1/capture-manifest.json";
    assert.equal(portableCapturePath(manifest), manifest);
  `);
});


test("portable seed paths reject absolute paths, traversal, unknown games and unexpected files", () => {
  checkPaths(`
    for (const path of ["C:/sessions/ams2/own/capture.bin", "../sessions/ams2/capture.bin", "sessions/ams2/../capture.bin", "sessions/pmr/capture.bin", "sessions/ams2/capture.txt", "sessions/lmu/own/../capture-manifest.json", "sessions/lmu/own/bundle/capture-manifest.json/../../capture.bin"]) {
      assert.throws(() => portableCapturePath(path), /Invalid seeded capture path/);
    }
  `);
});

test("normalized LMU bundle paths survive seed artifact restoration", () => {
  checkPaths(`
    const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, dirname } = await import("node:path");
    const { default: Database } = await import("libsql");
    const { normalizeSeededCapturePaths, restoreSeededDatabase } = await import("./playwright/support/server/seeded-database");
    const root = mkdtempSync(join(tmpdir(), "raceiq-seed-roundtrip-"));
    try {
      const source = join(root, "source");
      const target = join(root, "target");
      mkdirSync(source);
      mkdirSync(target);
      const database = new Database(join(source, "app.db"));
      database.exec("CREATE TABLE sessions (id INTEGER PRIMARY KEY, game_id TEXT, raw_file TEXT, capture_manifest_file TEXT); CREATE TABLE laps (session_id INTEGER, raw_frame_count INTEGER);");
      let manifestPath;
      for (const [index, game] of DEFAULT_GAMES.entries()) {
        const path = join(source, "sessions", game, "own", game === "lmu" ? "bundle/capture-manifest.json" : "capture.bin");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, game === "lmu" ? JSON.stringify({ marker: "retained LMU bundle" }) : "capture");
        const manifest = game === "lmu" ? path : null;
        if (manifest) manifestPath = path;
        database.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?)").run(index + 1, game, path, manifest);
        database.prepare("INSERT INTO laps VALUES (?, 1)").run(index + 1);
      }
      normalizeSeededCapturePaths(database, source);
      database.close();
      writeFileSync(join(source, "chat-memory.db"), "chat fixture");
      restoreSeededDatabase(root, target, join(source, "app.db"));
      const restored = new Database(join(target, "app.db"));
      try {
        const row = restored.prepare("SELECT raw_file, capture_manifest_file FROM sessions WHERE game_id = 'lmu'").get();
        const expected = join(target, "sessions/lmu/own/bundle/capture-manifest.json");
        assert.equal(row.raw_file, expected);
        assert.equal(row.capture_manifest_file, expected);
        assert.equal(readFileSync(expected, "utf8"), readFileSync(manifestPath, "utf8"));
      } finally { restored.close(); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  `);
});
