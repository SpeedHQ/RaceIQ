import { expect, test } from "bun:test";
import { resolve } from "node:path";

function checkPaths(assertions: string) {
  // Playwright support is a separate workspace; check its contract through Bun.
  const source = `
    import assert from "node:assert/strict";
    import { DEFAULT_GAMES } from "./packages/tooling-data/src/data/seed-db-options";
    import { portableCapturePath } from "./playwright/support/server/seeded-database";
    ${assertions}
  `;
  const result = Bun.spawnSync([process.execPath, "--eval", source], {
    cwd: resolve(import.meta.dir, "../../../.."), env: process.env, stdout: "pipe", stderr: "pipe",
  });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
}

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

test("portable seed paths reject absolute paths, traversal, unknown games and unexpected files", () => {
  checkPaths(`
    for (const path of ["C:/sessions/ams2/own/capture.bin", "../sessions/ams2/capture.bin", "sessions/ams2/../capture.bin", "sessions/pmr/capture.bin", "sessions/ams2/capture.txt"]) {
      assert.throws(() => portableCapturePath(path), /Invalid seeded capture path/);
    }
  `);
});
