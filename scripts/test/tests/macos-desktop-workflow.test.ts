import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

test("macOS desktop CI installs Rust before building and testing the native host", async () => {
  const workflow = await readFile(resolve(import.meta.dir, "../../../.github/workflows/build-test.yml"), "utf8");
  const job = workflow.match(/^  macos-desktop:\n([\s\S]*?)(?=^  [\w-]+:\n|$(?![\s\S]))/m)?.[1];
  expect(job).toBeDefined();

  const setup = job!.indexOf("- uses: dtolnay/rust-toolchain@stable");
  const build = job!.indexOf("run: bun run desktop:build");
  const nativeTest = job!.indexOf("run: cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml");
  expect(setup).toBeGreaterThanOrEqual(0);
  expect(build).toBeGreaterThan(setup);
  expect(nativeTest).toBeGreaterThan(build);
});
