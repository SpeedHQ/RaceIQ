import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { computeParaglideInputHash, type ParaglideHashInput } from "./paraglide-cache";
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

const BUILD_PROFILE = "paraglide-build-v1|message-modules|localStorage,baseLocale|ts-declarations";
const OUTPUT_DIR = "src/paraglide";
const MANIFEST = "project.inlang/.cache/raceiq-paraglide-build.json";
const LOCKFILE = "../bun.lock";
const BUILD_OPTIONS = ["--output-structure", "message-modules", "--strategy", "localStorage", "baseLocale", "--emit-ts-declarations"] as const;
const inFlight = new Map<string, Promise<void>>();

async function compilerVersion(clientRoot: string): Promise<string> {
  const require = createRequire(join(clientRoot, "package.json"));
  try {
    const packagePath = require.resolve("@inlang/paraglide-js/package.json");
    return JSON.parse(await readFile(packagePath, "utf8")).version;
  } catch {
    // Package export maps may hide package.json; resolve executable's package from installed node_modules.
    const packagePath = resolve(clientRoot, "node_modules/@inlang/paraglide-js/package.json");
    return JSON.parse(await readFile(packagePath, "utf8")).version;
  }
}

async function buildInputs(clientRoot: string): Promise<ParaglideHashInput[]> {
  const messages = join(clientRoot, "messages");
  const names = (await readdir(messages)).filter((name) => name.endsWith(".json")).sort();
  const inputs: ParaglideHashInput[] = [];
  for (const name of names) inputs.push([`messages/${name}`, await readFile(join(messages, name), "utf8")]);
  inputs.push(["project.inlang/settings.json", await readFile(join(clientRoot, "project.inlang/settings.json"), "utf8")]);
  inputs.push(["package.json", await readFile(join(clientRoot, "package.json"), "utf8")]);
  inputs.push(["bun.lock", await readFile(resolve(clientRoot, LOCKFILE), "utf8")]);
  inputs.push(["build-options", JSON.stringify(BUILD_OPTIONS)]);
  return inputs;
}

export async function getParaglideBuildKey(clientRoot: string): Promise<string> {
  const root = resolve(clientRoot);
  return computeParaglideInputHash(await buildInputs(root), `${BUILD_PROFILE}|${await compilerVersion(root)}`);
}

async function outputDigest(root: string): Promise<{ files: Record<string, string>; digest: string }> {
  const files: Record<string, string> = {};
  async function visit(dir: string, relative = ""): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path, name);
      else if (entry.isFile()) files[name] = createHash("sha256").update(await readFile(path)).digest("hex");
      else throw new Error(`Unexpected Paraglide output entry: ${path}`);
    }
  }
  await visit(root);
  const digest = createHash("sha256").update(JSON.stringify(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)))).digest("hex");
  return { files, digest };
}

async function isFresh(clientRoot: string, key: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(clientRoot, MANIFEST), "utf8")) as { key?: string; files?: Record<string, string>; digest?: string };
    if (manifest.key !== key || !manifest.files || !manifest.digest) return false;
    const current = await outputDigest(join(clientRoot, OUTPUT_DIR));
    return current.digest === manifest.digest && JSON.stringify(Object.entries(current.files).sort(([a], [b]) => a.localeCompare(b))) === JSON.stringify(Object.entries(manifest.files).sort(([a], [b]) => a.localeCompare(b)));
  } catch {
    return false;
  }
}
// Preserve directory identity for Windows readers that do not share delete access.
// Hashes come from outputDigest, so unchanged modules do not trigger watcher reloads.
export async function syncParaglideOutput(
  source: string,
  destination: string,
  sourceFiles: Readonly<Record<string, string>>,
  destinationFiles: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const [name, hash] of Object.entries(sourceFiles)) {
    if (destinationFiles[name] === hash) continue;
    const target = join(destination, name);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(source, name), target);
  }
  for (const name of Object.keys(destinationFiles)) {
    if (!(name in sourceFiles)) await rm(join(destination, name));
  }
}

async function compile(clientRoot: string, key: string): Promise<void> {
  console.log("[Paraglide] Compiling translations (cache miss)...");
  const cacheDir = dirname(join(clientRoot, MANIFEST));
  await mkdir(cacheDir, { recursive: true });
  const stage = await mkdtemp(join(cacheDir, "paraglide-build-"));
  const stageOut = join(stage, "output");
  const output = join(clientRoot, OUTPUT_DIR);
  const backup = join(stage, "previous-output");
  let movedOld = false;
  let installedNew = false;
  let copiedOld = false;
  let syncingOutput = false;
  let previousFiles: Record<string, string> = {};
  try {
    const child = Bun.spawn(["bunx", "paraglide-js", "compile", "--project", "./project.inlang", "--outdir", stageOut, ...BUILD_OPTIONS], {
      cwd: clientRoot, stdin: "ignore", stdout: "inherit", stderr: "inherit",
    });
    const status = await child.exited;
    if (status !== 0) throw new Error(`Paraglide compile failed (${status})`);
    const generated = await outputDigest(stageOut);
    if (!Object.keys(generated.files).length) throw new Error("Paraglide compile produced no output");
    if (process.platform === "win32") {
      let outputExists = false;
      try {
        await stat(output);
        outputExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (outputExists) {
        previousFiles = (await outputDigest(output)).files;
        await cp(output, backup, { recursive: true });
        copiedOld = true;
      }
      syncingOutput = true;
      await syncParaglideOutput(stageOut, output, generated.files, previousFiles);
    } else {
      try {
        await rename(output, backup);
        movedOld = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      await rename(stageOut, output);
      installedNew = true;
    }
    const manifest = { key, files: generated.files, digest: generated.digest };
    await writeFile(join(cacheDir, "raceiq-paraglide-build.json.tmp"), `${JSON.stringify(manifest, null, 2)}\n`);
    await rename(join(cacheDir, "raceiq-paraglide-build.json.tmp"), join(clientRoot, MANIFEST));
  } catch (error) {
    if (syncingOutput) {
      if (copiedOld) {
        const currentFiles = (await outputDigest(output)).files;
        await syncParaglideOutput(backup, output, previousFiles, currentFiles);
      } else await rm(output, { recursive: true, force: true });
    } else {
      if (installedNew) await rm(output, { recursive: true, force: true });
      if (movedOld) await rename(backup, output);
    }
    throw error;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function ensureParaglideBuild(clientRoot: string): Promise<void> {
  const root = resolve(clientRoot);
  const pending = inFlight.get(root);
  if (pending) return pending;
  const build = (async () => {
    const key = await getParaglideBuildKey(root);
    if (await isFresh(root, key)) {
      console.log("[Paraglide] Reusing validated translations");
      return;
    }
    await compile(root, key);
  })().finally(() => inFlight.delete(root));
  inFlight.set(root, build);
  return build;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let root = resolve(SCRIPT_DIR, "../../client");
  let keyOnly = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--client-root" && args[i + 1]) root = resolve(args[++i]);
    else if (args[i] === "--key") keyOnly = true;
    else throw new Error(`Unknown or incomplete argument: ${args[i]}`);
  }
  if (keyOnly) console.log(await getParaglideBuildKey(root));
  else await ensureParaglideBuild(root);
}

if (import.meta.main) await main();
