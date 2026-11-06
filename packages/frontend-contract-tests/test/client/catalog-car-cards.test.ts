import { expect, test } from "bun:test";
import { resolve } from "node:path";

test("catalog cards render correctly within the client workspace", () => {
  // Keep React and client-only imports inside their own TypeScript workspace.
  const result = Bun.spawnSync([process.execPath, "test", "./test/catalog-car-cards.test.tsx"], {
    cwd: resolve(import.meta.dir, "../../../../client"),
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
});
