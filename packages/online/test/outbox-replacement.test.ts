import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = join(import.meta.dir, "outbox-replacement.fixture.ts");

describe("outbox payload replacement persistence", () => {
  test("retains replaced artifacts across restart without replacing current files", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "raceiq-outbox-replacement-"));
    try {
      for (const mode of ["prepare", "recover"]) {
        const child = Bun.spawnSync([process.execPath, fixture, mode], { env: { ...process.env, DATA_DIR: dataDir }, timeout: 30_000 });
        expect(child.exitCode, child.stderr.toString()).toBe(0);
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
