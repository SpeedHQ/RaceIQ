#!/usr/bin/env bun

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const tempRoot = mkdtempSync(join(tmpdir(), "raceiq-replay-io-benchmark-"));
try {
  const child = Bun.spawn({
    cmd: [process.execPath, resolve("test/benchmarks/replay-io.bench.ts"), ...process.argv.slice(2)],
    cwd: process.cwd(),
    env: {
      ...process.env,
      DATA_DIR: join(tempRoot, "data"),
      RACEIQ_TEST_MODE: "1",
      NODE_ENV: "test",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exitCode = exitCode;
} finally {
  rmSync(tempRoot, { recursive: true, force: true });
}
