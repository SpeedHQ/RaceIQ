#!/usr/bin/env bun
import { ROOT_DIR } from "../root";
import { createHash } from "node:crypto";
import type { Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HELPER_VERSION = "1";
const OUTPUT_DIR = "storybook-static";
const METADATA_RELATIVE = "project.inlang/.cache/raceiq-storybook-build.json";
const BUILD_ENV = ["NODE_ENV", "STORYBOOK_BASE_URL", "STORYBOOK_DISABLE_TELEMETRY", "PROXY_TARGET", "SERVER_PORT"];
const OPERATIONAL_ENV: Record<string, true> = {
  RACEIQ_STORYBOOK_ROOT: true, RACEIQ_STORYBOOK_PORT: true, RACEIQ_STORYBOOK_PREBUILT: true,
  RACEIQ_SNAPSHOT_DIR: true, RACEIQ_SNAPSHOT_TEST_DIR: true, RACEIQ_SNAPSHOT_RESULTS_DIR: true,
  RACEIQ_UI_DIFF_CAPTURE: true, RACEIQ_CAPTURE_REUSABLE_UI: true,
};

type InventoryEntry = { path: string; size: number; digest: string };
type CacheMetadata = { version: number; key: string; outputs: InventoryEntry[] };

function hash(): Hash {
  return createHash("sha256");
}

async function digestFile(filePath: string): Promise<string> {
  const digest = hash();
  for await (const chunk of createReadStream(filePath)) digest.update(chunk);
  return digest.digest("hex");
}

async function listFiles(root: string, relative = ""): Promise<string[]> {
  const directory = path.join(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...await listFiles(root, child));
    } else if (entry.isFile()) {
      files.push(child);
    } else if (entry.isSymbolicLink()) {
      throw new Error(`Unsupported symbolic link in Storybook files: ${child}`);
    }
  }
  return files;
}

async function inventory(root: string): Promise<InventoryEntry[]> {
  const files = (await listFiles(root)).sort();
  const output: InventoryEntry[] = [];
  for (const relative of files) {
    const fullPath = path.join(root, relative);
    const details = await stat(fullPath);
    output.push({ path: relative, size: details.size, digest: await digestFile(fullPath) });
  }
  return output;
}

export async function getStorybookBuildKey(clientRoot: string): Promise<string> {
  const root = path.resolve(clientRoot);
  const repositoryRoot = path.dirname(root);
  // A pre-commit hook's Git directory/index must not override the target repo.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
  const tracked = Bun.spawnSync(["git", "-C", repositoryRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { env, stdout: "pipe", stderr: "pipe" });
  if (tracked.exitCode !== 0) throw new Error(`Could not enumerate repository inputs: ${tracked.stderr.toString()}`);
  const files = new Set(tracked.stdout.toString().split("\0").filter(Boolean));
  const generatedPrefixes = ["src/paraglide", OUTPUT_DIR, "project.inlang/.cache"].map(
    (directory) => `${path.relative(repositoryRoot, path.join(root, directory)).split(path.sep).join("/")}/`,
  );
  for (const relative of files) {
    if (generatedPrefixes.some((prefix) => relative.startsWith(prefix))) files.delete(relative);
  }
  for (const envRoot of [repositoryRoot, root]) {
    for (const entry of await readdir(envRoot, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(".env")) {
        files.add(path.relative(repositoryRoot, path.join(envRoot, entry.name)));
      }
    }
  }
  const digest = hash();
  for (const relative of [...files].sort()) {
    const filePath = path.join(repositoryRoot, relative);
    try {
      digest.update(relative).update("\0");
      const details = await lstat(filePath);
      if (details.isSymbolicLink()) digest.update(`link:${await readlink(filePath)}`).update("\0");
      else if (details.isFile()) digest.update(await digestFile(filePath)).update("\0");
      else throw new Error(`Unsupported Storybook source input: ${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const environment = Object.entries(process.env)
    .filter(([name]) =>
      (BUILD_ENV.includes(name) || name.startsWith("VITE_") || name.startsWith("RACEIQ_")) &&
      !OPERATIONAL_ENV[name] && name !== "NODE_OPTIONS",
    )
    .sort(([left], [right]) => left.localeCompare(right));
  const nodeVersion = Bun.spawnSync(["node", "--version"], { stdout: "pipe", stderr: "pipe" });
  if (nodeVersion.exitCode !== 0) throw new Error(`Could not determine Node version: ${nodeVersion.stderr.toString()}`);
  digest.update(JSON.stringify({
    helperVersion: HELPER_VERSION,
    helper: await readFile(fileURLToPath(import.meta.url)),
    node: nodeVersion.stdout.toString().trim(),
    bun: Bun.version,
    platform: process.platform,
    arch: process.arch,
    environment,
  }));
  return digest.digest("hex");
}

export async function verifyStorybookBuild(clientRoot: string): Promise<void> {
  const root = path.resolve(clientRoot);
  const metadataPath = path.join(root, METADATA_RELATIVE);
  const outputPath = path.join(root, OUTPUT_DIR);
  const key = await getStorybookBuildKey(root);
  if (!(await matchesCache(metadataPath, outputPath, key))) {
    throw new Error("Storybook static output is missing, stale, or corrupt");
  }
}

async function matchesCache(metadataPath: string, outputPath: string, key: string): Promise<boolean> {
  try {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as CacheMetadata;
    if (metadata.version !== 1 || metadata.key !== key || !Array.isArray(metadata.outputs)) return false;
    const current = await inventory(outputPath);
    return current.some(({ path: file }) => file === "index.html") &&
      current.some(({ path: file }) => file === "index.json") &&
      JSON.stringify(current) === JSON.stringify(metadata.outputs);
  } catch {
    return false;
  }
}

export async function ensureStorybookBuild(clientRoot: string): Promise<void> {
  const root = path.resolve(clientRoot);
  const key = await getStorybookBuildKey(root);
  const metadataPath = path.join(root, METADATA_RELATIVE);
  const outputPath = path.join(root, OUTPUT_DIR);
  if (await matchesCache(metadataPath, outputPath, key)) {
    console.log("[Storybook] Reusing validated static build");
    return;
  }
  console.log("[Storybook] Building static Storybook");
  // Playwright forces CI=true for its web server; use that profile for all builds.
  const env: NodeJS.ProcessEnv = { ...process.env, CI: "true", NODE_OPTIONS: "--max-old-space-size=4096" };
  for (const name of Object.keys(OPERATIONAL_ENV)) delete env[name];
  const result = Bun.spawnSync(["bunx", "storybook", "build", "--test", "--output-dir", OUTPUT_DIR], {
    cwd: root, env, stdout: "inherit", stderr: "inherit",
  });
  if (result.exitCode !== 0) throw new Error(`Storybook build failed with exit code ${result.exitCode}`);
  const outputs = await inventory(outputPath);
  if (!outputs.some(({ path: file }) => file === "index.html") ||
      !outputs.some(({ path: file }) => file === "index.json")) {
    throw new Error("Storybook build did not produce index.html and index.json");
  }
  const metadata: CacheMetadata = { version: 1, key: await getStorybookBuildKey(root), outputs };
  await mkdir(path.dirname(metadataPath), { recursive: true });
  const temporaryPath = `${metadataPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(metadata)}\n`);
  await rename(temporaryPath, metadataPath);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let clientRoot = path.resolve(ROOT_DIR, "client");
  let printKey = false;
  let verify = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--key") printKey = true;
    else if (args[index] === "--verify") verify = true;
    else if (args[index] === "--client-root" && args[index + 1]) clientRoot = path.resolve(args[++index]);
    else throw new Error(`Unknown or incomplete argument: ${args[index]}`);
  }
  if (printKey && verify) throw new Error("--key and --verify cannot be combined");
  if (printKey) console.log(await getStorybookBuildKey(clientRoot));
  else if (verify) await verifyStorybookBuild(clientRoot);
  else await ensureStorybookBuild(clientRoot);
}

if (import.meta.main) await main();

