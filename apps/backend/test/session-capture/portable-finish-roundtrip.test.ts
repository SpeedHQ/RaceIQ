import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("verified native portable import retains known finish through unknown metadata and rejects conflicts", async () => {
  const dataDir = await mkdtemp(join(await realpath(tmpdir()), "raceiq-portable-finish-"));
  const launcher = fileURLToPath(new URL("../fixtures/online-upload-native-source.ts", import.meta.url));
  const child = Bun.spawn([process.execPath, launcher], {
    cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
    env: { ...process.env, DATA_DIR: dataDir, RACEIQ_TEST_MODE: "1", DB_IN_MEMORY: "0", RACEIQ_E2E_PORTABLE_FINISH_CHECK: "1" },
    stdout: "pipe", stderr: "pipe", signal: AbortSignal.timeout(120_000),
  });
  try {
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, `${stdout}\n${stderr}`).toBe(0);
  } finally {
    child.kill();
    await child.exited;
    await rm(dataDir, { recursive: true, force: true });
  }
}, 125_000);
