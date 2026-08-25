import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { computeParaglideInputHash, type ParaglideHashInput } from "./paraglide-cache";

const ROOT = resolve(import.meta.dir, "../..");
const CLIENT = resolve(ROOT, "client");
const MESSAGES_DIR = resolve(CLIENT, "messages");
const SETTINGS_PATH = resolve(CLIENT, "project.inlang/settings.json");
const CACHE_PATH = resolve(CLIENT, "project.inlang/.cache/raceiq-paraglide-dev.json");
const OUTDIR = resolve(CLIENT, "src/paraglide");
const OUTPUT_MARKERS = ["messages.js", "runtime.js", "server.js", "messages/en.js", "messages/de.js"];
const COMPILER_FINGERPRINT = "paraglide-dev-v1|locale-modules|localStorage,baseLocale|no-declarations";

let compilePromise: Promise<void> | null = null;
let debounceTimer: Timer | null = null;
let shuttingDown = false;

async function readInputs(): Promise<ParaglideHashInput[]> {
  const entries = await Array.fromAsync(new Bun.Glob("*.json").scan({ cwd: MESSAGES_DIR, absolute: false }));
  const inputs: ParaglideHashInput[] = [];
  for (const name of entries.sort()) {
    inputs.push([`messages/${name}`, await Bun.file(resolve(MESSAGES_DIR, name)).text()]);
  }
  inputs.push(["project.inlang/settings.json", await Bun.file(SETTINGS_PATH).text()]);
  return inputs;
}

async function currentHash(): Promise<string> {
  return computeParaglideInputHash(await readInputs(), COMPILER_FINGERPRINT);
}

async function outputExists(): Promise<boolean> {
  return Promise.all(OUTPUT_MARKERS.map(async (name) => Bun.file(resolve(OUTDIR, name)).exists())).then((values) => values.every(Boolean));
}

async function isFresh(hash: string): Promise<boolean> {
  if (!(await outputExists())) return false;
  try {
    const cache = JSON.parse(await readFile(CACHE_PATH, "utf8")) as { hash?: string };
    return cache.hash === hash;
  } catch {
    return false;
  }
}

async function compile(hash: string): Promise<void> {
  console.log("[Paraglide] Compiling translation messages...");
  const child = Bun.spawn([
    "bunx",
    "paraglide-js",
    "compile",
    "--project",
    "./project.inlang",
    "--outdir",
    "./src/paraglide",
    "--output-structure",
    "locale-modules",
    "--strategy",
    "localStorage",
    "baseLocale",
    "--no-emit-ts-declarations",
  ], { cwd: CLIENT, stdin: "ignore", stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Paraglide compile failed (${exitCode})`);
  await mkdir(resolve(CLIENT, "project.inlang/.cache"), { recursive: true });
  await writeFile(CACHE_PATH, JSON.stringify({ hash }, null, 2) + "\n");
}

async function ensureCompiled(): Promise<void> {
  if (compilePromise) return compilePromise;
  compilePromise = (async () => {
    const hash = await currentHash();
    if (!(await isFresh(hash))) await compile(hash);
  })().finally(() => {
    compilePromise = null;
  });
  return compilePromise;
}

function queueCompile(): void {
  if (shuttingDown) return;
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    void ensureCompiled().catch((error) => console.error("[Paraglide] Watch compile failed:", error));
  }, 150);
}

async function main(): Promise<void> {
  await ensureCompiled();
  const watchers: FSWatcher[] = [
    watch(MESSAGES_DIR, { recursive: true }, queueCompile),
    watch(SETTINGS_PATH, queueCompile),
  ];
  const shutdown = () => {
    shuttingDown = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    for (const watcher of watchers) watcher.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  await new Promise<void>(() => {});
}

if (import.meta.main) await main();
