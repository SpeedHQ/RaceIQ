#!/usr/bin/env bun
import { resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../..");
const update = process.argv.includes("--update");
const image = "mcr.microsoft.com/playwright:v1.62.0-jammy";
const command = update ? "bun run snapshot" : "bun run snapshot:test";
const bootstrap = [
  "set -euo pipefail",
  "export HOME=/tmp",
  "apt-get update -qq && apt-get install -y -qq --no-install-recommends unzip",
  "curl -fsSL https://bun.sh/install | bash",
  "export PATH=\"$HOME/.bun/bin:$PATH\"",
  "export RACEIQ_CANONICAL_SNAPSHOT_ENV=1",
  "bun install --ignore-scripts",
  "cd client",
  "bun install --ignore-scripts",
  command,
].join(" && ");
try {
  const result = Bun.spawnSync(
    ["docker", "run", "--rm", "--ipc=host", "-v", `${repoRoot}:/work`, "-v", "/work/node_modules", "-v", "/work/client/node_modules", "-w", "/work", image, "bash", "-lc", bootstrap],
    { cwd: repoRoot, stdout: "inherit", stderr: "inherit" },
  );
  if (result.exitCode !== 0) {
    throw new Error(`Docker snapshot command failed with exit code ${result.exitCode}. Inspect the container output above for the underlying Playwright failure.`);
  }
} catch (error) {
  if (error instanceof Error && error.message.startsWith("Docker snapshot command failed")) throw error;
  throw new Error(`Unable to run Docker snapshot environment: ${error instanceof Error ? error.message : String(error)}`);
}
