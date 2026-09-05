import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zipSync } from "fflate";
import {
  cleanupExpiredStagedMotec,
  stageMotecArchive,
} from "../../server/motec/import-staging";

const MINUTE_MS = 60 * 1000;

test("maintenance removes expired MoTeC staging directories", async () => {
  const staged = await stageMotecArchive(zipSync({
    "session.ld": new Uint8Array([1]),
    "session.ldx": new Uint8Array([2]),
  }));
  const directory = join(tmpdir(), `raceiq-motec-${staged.token}`);
  const manifestPath = join(directory, "manifest.json");

  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.createdAt = Date.now() - 16 * MINUTE_MS;
    await writeFile(manifestPath, JSON.stringify(manifest));

    expect(await cleanupExpiredStagedMotec()).toBe(1);
    expect(await Bun.file(directory).exists()).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
