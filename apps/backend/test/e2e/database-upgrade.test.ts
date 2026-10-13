import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..");
const COMPLETE = "[SessionRepair] Historical session reconciliation complete:";
type Session = { id: number; track_id: string; lap_detector_version: string | null };

function environment(dataDir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, DATA_DIR: dataDir, NODE_ENV: "production" };
  delete env.RACEIQ_TEST_MODE;
  delete env.DB_IN_MEMORY;
  delete env.RACEIQ_TEST_DATA_DIR;
  delete env.PW_SEED_SCREENSHOTS;
  return env;
}

async function command(args: string[], cwd = ROOT, env = process.env) {
  const proc = Bun.spawn(args, { cwd, env, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`${args.join(" ")} exited ${code}\n${stdout}\n${stderr}`);
  return stdout;
}

function startBranch(dataDir: string) {
  const proc = Bun.spawn([process.execPath, "--eval", `
    import { captureConsole } from "./server/runtime/logger";
    import { bootServer } from "./apps/backend/src/runtime/boot";
    captureConsole();
    await bootServer({ httpPort: 0, udpPort: 0, recordingGameId: null });
  `], { cwd: ROOT, env: environment(dataDir), stdout: "pipe", stderr: "pipe" });
  let output = "";
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) output += decoder.decode(chunk, { stream: true });
  };
  const drained = Promise.all([consume(proc.stdout), consume(proc.stderr)]);
  let exited = false;
  void proc.exited.then(() => { exited = true; });
  return {
    async ready() {
      const deadline = Date.now() + 180_000;
      while (!output.includes(COMPLETE)) {
        if (exited || Date.now() >= deadline) throw new Error(`Branch startup failed:\n${output}`);
        // Another process's completion cannot be driven by this test's fake clock.
        await Bun.sleep(10);
      }
      expect(output).not.toContain("reconciliation failed:");
    },
    async stop() {
      if (!exited) proc.kill("SIGKILL");
      await proc.exited;
      await drained;
    },
  };
}

test("current startup reprocesses release-seeded Tourist sessions into correct lap results", async () => {
  const temporary = mkdtempSync(join(tmpdir(), "raceiq-release-upgrade-"));
  const releaseDir = join(temporary, "release");
  const dataDir = join(temporary, "data");
  mkdirSync(releaseDir);
  mkdirSync(dataDir);
  let backend: ReturnType<typeof startBranch> | undefined;
  let database: Database | undefined;
  try {
    const tags = (await command(["git", "tag", "--sort=-version:refname"])).trim().split(/\r?\n/);
    const tag = tags.find((value) => /^v\d+\.\d+\.\d+$/.test(value));
    if (!tag) throw new Error("No stable release tag available; fetch release tags before running database-upgrade.test.ts.");
    console.log(`[Upgrade] Baseline ${tag} -> current working branch`);
    const archive = join(temporary, "release.tar");
    await command(["git", "archive", "--format=tar", `--output=${archive}`, tag]);
    await command(["tar", "-xf", archive, "-C", releaseDir, "--exclude=.claude"]);
    // Release postinstall installs Git hooks and requires a repository.
    await command(["git", "init", "--quiet"], releaseDir);
    // Release dependencies must not resolve into current workspace code.
    await command([process.execPath, "install", "--frozen-lockfile"], releaseDir);
    const fixture = join(temporary, "ac-evo-tourist.bin.gz");
    writeFileSync(fixture, Buffer.concat([1, 2].map((part) =>
      readFileSync(join(ROOT, `test/artifacts/sessions/ac-evo-tourist-2026-10-10.bin.gz.part${part}`)),
    )));
    await command([process.execPath, "run", "db:seed", "--games=ac-evo", `--fixtures=${fixture}`], releaseDir, environment(dataDir));
    database = new Database(join(dataDir, "app.db"));
    database.exec("PRAGMA busy_timeout=5000;");
    const before = database.query<{ id: number; lap_detector_version: string | null }, []>("SELECT id,lap_detector_version FROM sessions ORDER BY id").all();
    expect(before.every((session) => session.lap_detector_version !== null)).toBe(true);
    // Deliberately stale results distinguish replay from a marker-only migration.
    database.exec("UPDATE laps SET lap_time=999; UPDATE sessions SET track_id='obsolete layout';");

    backend = startBranch(dataDir);
    await backend.ready();
    const after = database.query<Session, []>("SELECT id,track_id,lap_detector_version FROM sessions ORDER BY id").all();
    expect(after.map((session) => session.id)).toEqual(before.map((session) => session.id));
    for (const session of after) {
      expect(session.track_id).toBe('["Nurburgring","Touristenfahrten"]');
      expect(session.lap_detector_version).not.toBeNull();
    }
    const finishes = database.query<{ lap_time: number }, []>("SELECT lap_time FROM laps WHERE is_valid=1 AND invalid_reason IS NULL ORDER BY lap_time").all();
    expect(finishes).toEqual([{ lap_time: 398.781 }, { lap_time: 401.277 }]);
    expect(database.query("SELECT id FROM laps WHERE lap_time=999").all()).toEqual([]);
  } finally {
    await backend?.stop();
    database?.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 600_000);
