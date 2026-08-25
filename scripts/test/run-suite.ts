import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, relative, sep } from "node:path";
import { checkTestShards } from "./check-shards";

const suite = process.argv[2];
if (suite !== "unit" && suite !== "integration") {
  console.error("Usage: bun scripts/test/run-suite.ts <unit|integration>");
  process.exit(2);
}

const root = resolve(import.meta.dir, "../..");
checkTestShards(root);
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
if ((suite === "unit" && !/^\d+$/.test(workers)) || (suite === "unit" && Number(workers) < 1)) {
  throw new Error("BUN_TEST_WORKERS must be a positive integer");
}
const i18nCompile = Bun.spawnSync([process.execPath, "run", "--cwd", "client", "i18n:compile"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if (i18nCompile.exitCode !== 0) process.exit(i18nCompile.exitCode);
const suiteRoot = mkdtempSync(resolve(tmpdir(), `raceiq-bun-${suite}-`));
let status = 1;
try {
  const suiteRootToml = suiteRoot.replaceAll("\\", "/");
  const configPath = resolve(suiteRoot, "bunfig.toml");
  const preload = resolve(root, "test/support/setup-data-dir.ts").replaceAll("\\", "/");
  writeFileSync(
    configPath,
    suite === "unit" ? `[test]\nroot = "${suiteRootToml}"\ntimeout = 30000\n` : `[test]\nroot = "${suiteRootToml}"\npreload = ["${preload}"]\ntimeout = 30000\nmaxConcurrency = 1\n`,
  );
  const canSplitIntegration =
    suite === "integration" && process.env.DATA_DIR === undefined;
  const serialFiles = canSplitIntegration
    ? files.filter((file) => file === "test/db/db-seed.test.ts")
    : [];
  const remainingFiles =
    serialFiles.length > 0
      ? files.filter((file) => file !== "test/db/db-seed.test.ts")
      : files;
  const fixtureFiles = canSplitIntegration
    ? remainingFiles.filter(
        (file) =>
          (file.startsWith("test/e2e/") &&
            file !== "test/e2e/udp-recording.test.ts") ||
          file.startsWith("test/motec/"),
      )
    : [];
  const primaryFiles =
    fixtureFiles.length > 0
      ? remainingFiles.filter((file) => !fixtureFiles.includes(file))
      : remainingFiles;
  let dataIndex = 0;
  const startGroup = (group: readonly string[]) => {
    const manifestFiles = group.map((file) => resolve(root, file));
    const args =
      suite === "unit"
        ? ["test", "--config", configPath, "--parallel", workers, ...manifestFiles]
        : ["test", "--config", configPath, "--max-concurrency=1", ...manifestFiles];
    const env = { ...process.env };
    if (suite === "unit") env.RACEIQ_UNIT_TESTS = "1";
    if (suite === "integration" && env.DATA_DIR === undefined) {
      dataIndex += 1;
      env.DATA_DIR = resolve(suiteRoot, `data-${dataIndex}`);
    }
    return Bun.spawn([process.execPath, ...args], {
      cwd: root,
      env,
      stdout: "inherit",
      stderr: "inherit",
    });
  };

  status = 0;
  if (serialFiles.length > 0) {
    status = await startGroup(serialFiles).exited;
  }
  if (status === 0 && fixtureFiles.length > 0) {
    let nextFixtureIndex = 0;
    const runFixtureWorker = async (): Promise<number> => {
      while (nextFixtureIndex < fixtureFiles.length) {
        const file = fixtureFiles[nextFixtureIndex];
        nextFixtureIndex += 1;
        if (!file) break;
        const code = await startGroup([file]).exited;
        if (code !== 0) return code;
      }
      return 0;
    };
    const primary = startGroup(primaryFiles);
    const [primaryCode, fixtureCodes] = await Promise.all([
      primary.exited,
      Promise.all(
        Array.from(
          { length: Math.min(2, fixtureFiles.length) },
          () => runFixtureWorker(),
        ),
      ),
    ]);
    status =
      primaryCode !== 0
        ? primaryCode
        : fixtureCodes.find((code) => code !== 0) ?? 0;
  } else if (status === 0) {
    status = await startGroup(primaryFiles).exited;
  }
} finally {
  rmSync(suiteRoot, { recursive: true, force: true });
}
process.exit(status);
