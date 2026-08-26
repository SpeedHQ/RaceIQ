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
const common = [
  "--processes=3",
  "--retained-processes=15",
  "--retained-warmups=1",
  "--warmup-ms=3000",
  "--measurement-ms=5000",
  "--min-samples=20",
  "--max-samples=200",
];
const filesToSync = [
  "scripts/quality/process-bench.ts",
  "test/benchmarks/process-bench-contracts.ts",
  "test/benchmarks/process-bench-runtime.ts",
  "test/benchmarks/process-bench-child.ts",
  "test/benchmarks/replay-process-bench.ts",
];
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
async function syncHarness(): Promise<void> {
  for (const relativePath of filesToSync) {
    const source = join(currentDir, relativePath);
    const target = join(baseDir, relativePath);
    if (!existsSync(source)) throw new Error(`Current checkout missing ${relativePath}`);
    await Bun.write(target, Bun.file(source));
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
  const reportPath = join(reportsDir, `${round.revision}.json`);
  await run([
    bun,
    "run",
    "scripts/quality/process-bench.ts",
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
const comparator = join(currentDir, "scripts/quality/bench-compare.ts");
const comparisonArgs = [
  bun,
  "run",
  comparator,
  ...pairs,
  "--median-threshold=10",
  "--retained-heap-threshold=10",
  "--max-cpu-error=3",
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
