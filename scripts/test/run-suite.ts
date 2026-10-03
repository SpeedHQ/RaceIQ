import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { checkTestShards } from "./check-shards";
import { discoverTestOwners, readSuiteFiles, SUITES, type Suite } from "./owners";
const args = process.argv.slice(2);
const requested = args[0];
let packageName: string | undefined;
if (args.length === 3 && args[1] === "--package") packageName = args[2];
else if (args.length !== 1) usage();
if (!requested || ![...SUITES, "all"].includes(requested as Suite | "all")) usage();

function usage(): never {
  console.error("Usage: bun scripts/test/run-suite.ts <unit|tooling|integration|e2e|all> [--package <name>]");
  process.exit(2);
}

const root = resolve(import.meta.dir, "../..");
const owners = discoverTestOwners(root);
const selectedOwners = packageName ? owners.filter((owner) => owner.name === packageName) : owners;
if (packageName && selectedOwners.length === 0) {
  console.error(`Unknown test owner: ${packageName}`);
  process.exit(2);
}
checkTestShards(root);

const runPairs: Array<{ owner: (typeof owners)[number]; suite: Suite }> = [];
const requestedSuites = requested === "all" ? SUITES : [requested as Suite];
const ownersWithSuites = new Set<string>();
for (const suite of requestedSuites) {
  for (const owner of selectedOwners) {
    const manifest = resolve(root, owner.root, "test", `${suite}-files.txt`);
    if (!existsSync(manifest)) {
      if (requested !== "all" && packageName) throw new Error(`${manifest}: suite manifest is required`);
      continue;
    }
    readSuiteFiles(root, owner, suite);
    ownersWithSuites.add(owner.name);
    runPairs.push({ owner, suite });
  }
}
if (requested === "all" && packageName) {
  for (const owner of selectedOwners) {
    if (!ownersWithSuites.has(owner.name)) throw new Error(`${owner.name}: owner has no test suites`);
  }
}
if (runPairs.length === 0) throw new Error("No test suites selected");

async function run(owner: (typeof owners)[number], suite: Suite): Promise<number> {
  const unit = suite === "unit";
  const isolatedDir = await mkdtemp(resolve(tmpdir(), `raceiq-${owner.name.replace(/[^a-zA-Z0-9-]/g, "-")}-${suite}-`));
  try {
    const files = readSuiteFiles(root, owner, suite);
    const configPath = resolve(isolatedDir, "bunfig.toml");
    const tomlPath = isolatedDir.replaceAll("\\", "/");
    const preloads = unit ? [] : [resolve(root, "server/test-support/setup-data-dir.ts")];
    if (!unit && ["@raceiq/backend", "@raceiq/frontend-contract-tests"].includes(owner.name)) {
      preloads.push(resolve(root, "apps/backend/test/support/setup-app.ts"));
    }
    const preloadToml = preloads.length
      ? `preload = [${preloads.map((path) => `"${path.replaceAll("\\", "/")}"`).join(", ")}]\n`
      : "";
    writeFileSync(configPath, `[test]\nroot = "${tomlPath}"\n${preloadToml}timeout = 40000\n${unit ? "" : "maxConcurrency = 1\n"}`);
    const workers = process.env.BUN_TEST_WORKERS ?? "4";
    if (unit && (!/^\d+$/.test(workers) || Number(workers) < 1)) throw new Error("BUN_TEST_WORKERS must be a positive integer");
    const paths = files.map((file) => resolve(root, file));
    const bunArgs = unit
      ? ["test", "--config", configPath, "--timeout=20000", "--parallel", workers, ...paths]
      : ["test", "--config", configPath, "--timeout=20000", "--max-concurrency=1", ...paths];
    const env = { ...process.env, DATA_DIR: isolatedDir, RACEIQ_TEST_DATA_DIR: isolatedDir };
    if (unit) env.RACEIQ_UNIT_TESTS = "1";
    else delete env.RACEIQ_UNIT_TESTS;
    const proc = Bun.spawn([process.execPath, ...bunArgs], { cwd: root, env, stdout: "inherit", stderr: "inherit" });
    return await proc.exited;
  } finally {
    await rm(isolatedDir, { recursive: true, force: true });
  }
}

for (const { owner, suite } of runPairs) {
  const status = await run(owner, suite);
  if (status !== 0) process.exit(status);
}
