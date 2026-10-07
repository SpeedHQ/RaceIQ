#!/usr/bin/env bun
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const option = (name: string): string | undefined => args.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1);
const root = resolve(dirname(import.meta.path), "../..");
const currentDir = resolve(option("--current") ?? root);
const baseDir = resolve(option("--base") ?? join(root, "../RaceIQ-base"));
const reportsDir = resolve(option("--reports") ?? join(root, "reports"));
const bun = process.execPath;
// Keep CI within runner memory/time limits while retaining paired comparisons.
// Each child reloads a large replay fixture, so excessive retained-heap samples
// multiply setup cost without improving the median enough to justify it.
const common = [
  "--processes=2",
  "--retained-processes=5",
  "--retained-warmups=1",
  "--warmup-ms=1000",
  "--measurement-ms=2000",
  "--min-samples=10",
  "--max-samples=100",
];
const harnessFiles = [
  "apps/backend/scripts/quality/process-bench.ts",
  "apps/backend/test/benchmarks/process-bench-contracts.ts",
  "apps/backend/test/benchmarks/process-bench-runtime.ts",
  "apps/backend/test/benchmarks/process-bench-child.ts",
  "apps/backend/test/benchmarks/replay-process-bench.ts",
  "apps/backend/test/benchmarks/mitata-harness.ts",
] as const;
const rounds = [
  { revision: "base-1", checkout: "base", caseOrder: "forward" },
  { revision: "current-1", checkout: "current", caseOrder: "forward" },
  { revision: "current-2", checkout: "current", caseOrder: "reverse" },
  { revision: "base-2", checkout: "base", caseOrder: "reverse" },
  { revision: "current-3", checkout: "current", caseOrder: "reverse" },
  { revision: "base-3", checkout: "base", caseOrder: "reverse" },
  { revision: "base-4", checkout: "base", caseOrder: "forward" },
  { revision: "current-4", checkout: "current", caseOrder: "forward" },
] as const;

function requireDirectory(path: string, label: string): void {
  if (!existsSync(path)) throw new Error(`${label} directory does not exist: ${path}`);
}
function requireOptionValue(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}
const legacyBase = !existsSync(join(baseDir, "apps/backend/src/games/init.ts"));
const legacyImportRewrites: Record<string, string> = {
  "@raceiq/backend-core/runtime/config/paths": "../../server/runtime/config/paths",
  "@raceiq/backend-core/db/telemetry-replay-storage": "../../server/db/telemetry-replay-storage",
  "@raceiq/backend-core/telemetry/replay": "../../server/telemetry/replay",
  "@raceiq/backend-core/games/registry": "../../server/games/registry",
  "@raceiq/capture-formats/session/framing": "../../packages/capture-formats/src/session/framing",
  "@raceiq/shared/telemetry/types": "../../shared/telemetry/types",
  "@raceiq/game-catalogs/games/init": "../../shared/games/init",
  "@raceiq/shared/games/ids": "../../shared/games/ids",
  "../../src/games/init": "../../server/games/init",
};
function harnessTarget(relativePath: typeof harnessFiles[number]): string {
  if (!legacyBase) return join(baseDir, relativePath);
  if (relativePath === "apps/backend/scripts/quality/process-bench.ts") return join(baseDir, "scripts/quality/process-bench.ts");
  return join(baseDir, relativePath.replace("apps/backend/", ""));
}
async function syncHarness(): Promise<void> {
  for (const relativePath of harnessFiles) {
    const source = join(currentDir, relativePath);
    const target = harnessTarget(relativePath);
    if (!existsSync(source)) throw new Error(`Current checkout missing ${relativePath}`);
    mkdirSync(dirname(target), { recursive: true });
    let contents = await Bun.file(source).text();
    if (legacyBase) {
      for (const [specifier, replacement] of Object.entries(legacyImportRewrites)) {
        contents = contents.replaceAll(`"${specifier}"`, `"${replacement}"`);
      }
    }
    await Bun.write(target, contents);
  }
}
async function run(command: string[], cwd: string): Promise<void> {
  const child = Bun.spawn(command, { cwd, stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
}

requireOptionValue("--base", option("--base"));
requireOptionValue("--current", option("--current"));
requireDirectory(baseDir, "Base checkout");
requireDirectory(currentDir, "Current checkout");
mkdirSync(reportsDir, { recursive: true });
await syncHarness();

for (const round of rounds) {
  const checkout = round.checkout === "base" ? baseDir : currentDir;
  const benchmarkScript = existsSync(join(checkout, "apps/backend/src/games/init.ts"))
    ? "apps/backend/scripts/quality/process-bench.ts"
    : "scripts/quality/process-bench.ts";
  const reportPath = join(reportsDir, `${round.revision}.json`);
  await run([
    bun,
    "run",
    benchmarkScript,
    "--suite=replay",
    `--revision=${round.revision}`,
    ...common,
    `--case-order=${round.caseOrder}`,
    `--output=${reportPath}`,
  ], checkout);
}

const pairs = rounds.reduce<string[]>((paths, round, index) => {
  if (index % 2 === 0) {
    paths.push(join(reportsDir, `${round.revision}.json`));
    paths.push(join(reportsDir, `${rounds[index + 1]!.revision}.json`));
  }
  return paths;
}, []);
const comparisonPath = join(reportsDir, "comparison.md");
const comparator = join(currentDir, "apps/backend/scripts/quality/bench-compare.ts");
const comparisonArgs = [
  bun,
  "run",
  comparator,
  ...pairs,
  "--median-threshold=10",
  "--retained-heap-threshold=10",
  "--max-cpu-error=10",
  "--max-retained-heap-error=5",
  "--bootstrap-samples=10000",
];
const comparatorChild = Bun.spawn(comparisonArgs, { cwd: currentDir, stdout: "pipe", stderr: "inherit" });
const [comparatorExit, output] = await Promise.all([
  comparatorChild.exited,
  new Response(comparatorChild.stdout).text(),
]);
if (comparatorExit !== 0) throw new Error(`Comparator failed (${comparatorExit})`);
await Bun.write(comparisonPath, output);
if (process.env.GITHUB_STEP_SUMMARY) await Bun.write(process.env.GITHUB_STEP_SUMMARY, output);
if (output.trim()) process.stdout.write(output);
if (!output.includes("| Result |")) throw new Error("Comparator emitted no benchmark table");
console.log(`Benchmark reports written to ${reportsDir}`);
