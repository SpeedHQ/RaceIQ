import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { FIXTURES } from "./live-lossless-release.bench";

type Args = { output: string; game?: string; trials: number; fps: number; sampleLimit?: number };
function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  for (const arg of argv) {
    const m = /^--([a-z-]+)=(.*)$/.exec(arg);
    if (!m || values.has(m[1]!)) throw new Error(`Expected unique --name=value option: ${arg}`);
    values.set(m[1]!, m[2]!);
  }
  for (const key of values.keys()) if (!["output", "game", "trials", "fps", "sample-limit"].includes(key)) throw new Error(`Unknown option --${key}`);
  const output = values.get("output");
  if (!output) throw new Error("--output=<path> is required");
  const game = values.get("game");
  if (game && !FIXTURES.some((f) => f.gameId === game)) throw new Error(`No fixture coverage for game ${game}`);
  const trials = Number(values.get("trials") ?? 1), fps = Number(values.get("fps") ?? 240);
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 20) throw new Error("--trials must be 1..20");
  if (!Number.isFinite(fps) || fps < 1 || fps > 10_000) throw new Error("--fps must be 1..10000");
  const sampleLimit = values.has("sample-limit") ? Number(values.get("sample-limit")) : undefined;
  if (sampleLimit !== undefined && (!Number.isSafeInteger(sampleLimit) || sampleLimit < 1)) throw new Error("--sample-limit must be a positive integer");
  return { output: resolve(output), ...(game ? { game } : {}), trials, fps, ...(sampleLimit ? { sampleLimit } : {}) };
}
async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  const root = resolve(import.meta.dir, "../../../../");
  const fixtureRoot = resolve(root, "test/artifacts/sessions");
  const fixtures = args.game ? FIXTURES.filter((f) => f.gameId === args.game) : [...FIXTURES];
  if (fixtures.length !== (args.game ? 1 : 6)) throw new Error("Required six-game fixture coverage unavailable");
  const output: Record<string, unknown>[] = [];
  await mkdir(dirname(args.output), { recursive: true });
  const temp = await mkdtemp(resolve(tmpdir(), "raceiq-direct-lap-bench-"));
  try {
    for (const item of fixtures) {
      const fixturePath = resolve(fixtureRoot, item.fixture);
      const fixture = await readFile(fixturePath);
      for (let trial = 1; trial <= args.trials; trial++) {
        const workDir = resolve(temp, `${item.gameId}-${trial}`);
        await mkdir(workDir, { recursive: true });
        const config = resolve(workDir, "config.json");
        const result = resolve(workDir, "result.json");
        await writeFile(config, JSON.stringify({ gameId: item.gameId, trial, fixturePath, fixtureSha256: createHash("sha256").update(fixture).digest("hex"), fps: args.fps, ...(args.sampleLimit ? { sampleLimit: args.sampleLimit } : {}), result }));
        await Promise.all([
          writeFile(`${args.output}.${item.gameId}-${trial}.stdout.log`, ""),
          writeFile(`${args.output}.${item.gameId}-${trial}.stderr.log`, ""),
        ]);
        console.log(`Recording ${item.gameId}, trial ${trial}, ${args.fps} native frames/s`);
        const child = Bun.spawn([process.execPath, "run", resolve(import.meta.dir, "direct-lap-recording-worker.ts"), `--config=${config}`], {
          cwd: root, env: { ...process.env, DATA_DIR: resolve(workDir, "data"), RACEIQ_TEST_MODE: "1", RACEIQ_FEATURE_F1_EXPERIMENTS: "true", RACEIQ_FEATURE_IRACING_ADAPTER: "true" },
          stdout: Bun.file(`${args.output}.${item.gameId}-${trial}.stdout.log`),
          stderr: Bun.file(`${args.output}.${item.gameId}-${trial}.stderr.log`),
        });
        const status = await child.exited;
        if (status !== 0) {
          console.error((await Bun.file(`${args.output}.${item.gameId}-${trial}.stderr.log`).text()).slice(-6000));
          throw new Error(`${item.gameId} trial ${trial} failed with exit ${status}`);
        }
        output.push(JSON.parse(await Bun.file(result).text()));
      }
    }
    const report = { benchmark: "direct-lap-recording", createdAt: new Date().toISOString(), requestedGames: fixtures.map((f) => f.gameId), trials: args.trials, fps: args.fps, diagnosticSampleLimit: args.sampleLimit ?? null, fullDetectorBoundaryCoverageRequired: args.sampleLimit === undefined, results: output };
    await mkdir(dirname(args.output), { recursive: true });
    await writeFile(args.output, `${JSON.stringify(report, null, 2)}\n`);
    if (args.sampleLimit === undefined && output.some((row) => {
      const coverage = row.boundaryCoverage;
      return !coverage || typeof coverage !== "object" || !("complete" in coverage) || coverage.complete !== true;
    })) throw new Error("Full detector lap-boundary coverage missing");
    console.log(`Wrote ${args.output}`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
export { parseArgs };
if (import.meta.main) await main();
