import assert from "node:assert/strict";
import { mkdir, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

const dataDir = process.env.DATA_DIR;
assert.ok(dataDir, "DATA_DIR must point to a new temporary directory");
const tempRoot = await realpath(tmpdir());
const requested = resolve(dataDir);
assert.ok(requested.startsWith(`${tempRoot}${sep}`), "Refuse DATA_DIR outside temporary storage");
await mkdir(requested, { recursive: true });
assert.deepEqual(await readdir(requested), [], "Refuse nonempty DATA_DIR");
const child = Bun.spawn(["bun", "--no-env-file", join(import.meta.dir, "online-upload-native-source-worker.ts")], {
  cwd: resolve(import.meta.dir, "../../../.."),
  env: { ...process.env, RACEIQ_NATIVE_SOURCE_LAUNCH_TOKEN: crypto.randomUUID() },
  stdout: "inherit", stderr: "inherit",
});
process.exitCode = await child.exited;
