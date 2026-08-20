import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, relative, sep } from "node:path";

const suite = process.argv[2];
if (suite !== "unit" && suite !== "integration") {
  console.error("Usage: bun scripts/test/run-suite.ts <unit|integration>");
  process.exit(2);
}

const root = resolve(import.meta.dir, "../..");
const manifestPath = resolve(root, "scripts/test", `${suite}-files.txt`);
const config = suite === "unit" ? "bunfig.unit.toml" : "bunfig.integration.toml";
const text = await Bun.file(manifestPath).text();
const files: string[] = [];
const seen = new Set<string>();
for (const [index, raw] of text.split(/\r?\n/).entries()) {
  const line = raw.trim();
  if (!line || line.startsWith("#")) continue;
  const normalized = line.replaceAll("\\", "/");
  const absolute = resolve(root, normalized);
  const relativePath = relative(root, absolute).replaceAll(sep, "/");
  if (relativePath !== normalized || !relativePath.startsWith("test/")) {
    throw new Error(`${manifestPath}:${index + 1}: path must stay inside test/: ${line}`);
  }
  if (!/\.test\.tsx?$/.test(relativePath)) {
    throw new Error(`${manifestPath}:${index + 1}: invalid test path: ${line}`);
  }
  if (seen.has(relativePath)) throw new Error(`${manifestPath}:${index + 1}: duplicate path: ${line}`);
  if (!(await Bun.file(absolute).exists())) throw new Error(`${manifestPath}:${index + 1}: missing path: ${line}`);
  seen.add(relativePath);
  files.push(relativePath);
}
if (files.length === 0) throw new Error(`${manifestPath}: no test files`);

const workers = process.env.BUN_TEST_WORKERS ?? "4";
if (suite === "unit" && !/^\d+$/.test(workers) || suite === "unit" && Number(workers) < 1) {
  throw new Error("BUN_TEST_WORKERS must be a positive integer");
}
const suiteRoot = mkdtempSync(resolve(tmpdir(), `raceiq-bun-${suite}-`));
const configPath = resolve(suiteRoot, "bunfig.toml");
const preload = resolve(root, "test/support/setup-data-dir.ts").replaceAll("\\", "/");
writeFileSync(configPath, suite === "unit"
  ? "[test]\nroot = \".\"\ntimeout = 30000\n"
  : `[test]\nroot = "."\npreload = ["${preload}"]\ntimeout = 30000\nmaxConcurrency = 2\n`);
const manifestFiles = files.map((file) => resolve(root, file));
const args = suite === "unit"
  ? ["test", "--config", configPath, "--parallel", workers, ...manifestFiles]
  : ["test", "--config", configPath, "--max-concurrency=2", ...manifestFiles];
const env = { ...process.env };
if (suite === "integration" && env.DATA_DIR === undefined) env.DATA_DIR = resolve(root, ".data-test");
try {
  const proc = Bun.spawn([process.execPath, ...args], { cwd: suiteRoot, env, stdout: "inherit", stderr: "inherit" });
  const status = await proc.exited;
  process.exit(status);
} finally {
  rmSync(suiteRoot, { recursive: true, force: true });
}
