import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateRustImportManifest } from "@raceiq/backend-core/session-capture/import-results";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "raceiq-manifest-"));
  roots.push(root);
  const outputRoot = join(root, "job");
  symlinkSync(root, outputRoot, process.platform === "win32" ? "junction" : "dir");
  const capture = join(root, "capture.bin");
  writeFileSync(capture, "capture");
  const manifest = { version: 1, jobId: "job", operation: "import", packetCount: 0, sessions: [], artifacts: [realpathSync(capture)] };
  return { root, outputRoot, manifest };
}

test("Rust import accepts canonical artifacts beneath an aliased job root", () => {
  const { outputRoot, manifest } = fixture();
  expect(validateRustImportManifest(manifest, { jobId: "job", outputRoot }).artifacts).toEqual(manifest.artifacts);
});

test("Rust import rejects an artifact symlink escaping its job root", () => {
  const { root, outputRoot, manifest } = fixture();
  const outside = mkdtempSync(join(tmpdir(), "raceiq-outside-"));
  roots.push(outside);
  const capture = join(outside, "capture.bin");
  writeFileSync(capture, "capture");
  const alias = join(root, "escape.bin");
  symlinkSync(capture, alias, process.platform === "win32" ? "file" : undefined);
  manifest.artifacts = [alias];
  expect(() => validateRustImportManifest(manifest, { jobId: "job", outputRoot })).toThrow("path escapes job root");
});
