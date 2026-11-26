import { test as bunTest } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Parent removes fixture files after process exit releases libSQL's native handles. */
export function nativeDatabaseTest(file: string) {
  return (name: string, scenario: () => void | Promise<void>) => {
    if (process.env.RACEIQ_NATIVE_DB_CASE) {
      if (process.env.RACEIQ_NATIVE_DB_CASE === name) bunTest(name, scenario);
      return;
    }
    bunTest(name, async () => {
      const directory = await mkdtemp(join(tmpdir(), "raceiq-native-db-"));
      try {
        const config = join(directory, "bunfig.toml");
        await writeFile(config, `[test]\nroot = ${JSON.stringify(directory.replaceAll("\\", "/"))}\npreload = []\n`);
        const child = Bun.spawn([process.execPath, "test", "--timeout=10000", `--config=${config}`, file], {
          env: {
            ...process.env,
            DATA_DIR: directory,
            RACEIQ_TEST_DATA_DIR: directory,
            RACEIQ_TEST_MODE: "1",
            RACEIQ_NATIVE_DB_CASE: name,
            RACEIQ_NATIVE_DB_ROOT: directory,
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const deadline = setTimeout(() => child.kill(), 15000);
        try {
          const [code, stdout, stderr] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
          ]);
          if (code !== 0) throw new Error(`Native database scenario failed (${code}):\n${stdout}\n${stderr}`);
        } finally {
          clearTimeout(deadline);
          child.kill();
          await child.exited;
        }
      } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      }
    }, 20000);
  };
}
