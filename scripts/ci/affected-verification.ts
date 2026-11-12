import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = new URL("../..", import.meta.url).pathname;
const features = ["tracks-catalogue", "cars-catalogue", "lap-replay", "sessions-page", "session-analyse"] as const;
const seededLegacy = ["seeded-e2e", "seeded-routes", "seeded-imports"];
const known = ["fresh-install", "tunes-setup", "tunes", "tunes-unseeded", "seeded-setup", ...seededLegacy, ...features, "lap-replay-webgpu", "record-demo"];
const taskNames = ["e2e:impact", "browser:fresh:impact", "browser:tunes:impact", "browser:tunes-unseeded:impact", "browser:seeded:impact", "visual:responsive:impact", "visual:storybook:impact"];

function workspaceNames() {
  const config = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string; workspaces: string[] };
  const names = new Map<string, boolean>([[config.name, false], ["//", false]]);
  for (const workspace of config.workspaces) {
    for (const path of new Bun.Glob(`${workspace}/package.json`).scanSync({ cwd: root, onlyFiles: true })) {
      const manifest = JSON.parse(readFileSync(join(root, path), "utf8")) as { name?: string; scripts?: Record<string, string> };
      if (!manifest.name || names.has(manifest.name)) throw new Error(`invalid workspace manifest: ${path}`);
      const configPath = join(root, path.slice(0, -"package.json".length), "turbo.json");
      const taskConfig = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) as { tasks?: Record<string, unknown> } : undefined;
      names.set(manifest.name, Boolean(manifest.scripts?.["e2e:impact"] || taskConfig?.tasks?.["e2e:impact"]));
    }
  }
  const rootConfig = JSON.parse(readFileSync(join(root, "turbo.json"), "utf8")) as { tasks?: Record<string, unknown> };
  for (const name of Object.keys(rootConfig.tasks ?? {})) {
    if (!name.endsWith("#e2e:impact")) continue;
    const owner = name.slice(0, -"#e2e:impact".length);
    if (!names.has(owner)) throw new Error(`unknown impact task owner: ${owner}`);
    names.set(owner, true);
  }
  return names;
}
type Row = { name: string; serverSet: "fresh" | "tunes" | "tunes-unseeded" | "seeded"; projects: string[]; shard: string | null };
function inventory() {
  const projects: unknown = JSON.parse(command([
    process.execPath,
    "-e",
    `import { createProjects } from "./playwright/config/projects";
import { runtime } from "./playwright/config/runtime";
console.log(JSON.stringify(createProjects(runtime).map((project) => project.name)));`,
  ]));
  if (!Array.isArray(projects) || !projects.every((name): name is string => typeof name === "string") ||
      projects.length !== known.length || new Set(projects).size !== known.length || known.some((name) => !projects.includes(name))) {
    throw new Error("Playwright project inventory does not match selector");
  }
}
function validateImpactTasks() {
  const rootTasks = (JSON.parse(readFileSync(join(root, "turbo.json"), "utf8")) as { tasks: Record<string, unknown> }).tasks;
  const browserTasks = (JSON.parse(readFileSync(join(root, "playwright/turbo.json"), "utf8")) as { tasks: Record<string, unknown> }).tasks;
  const packages = workspaceNames();
  for (const feature of features) {
    if (!packages.get(`@raceiq/${feature}`)) throw new Error(`missing feature impact task: ${feature}`);
  }
  for (const task of taskNames.slice(1)) {
    if (!rootTasks[task] || !browserTasks[task]) throw new Error(`missing impact task configuration: ${task}`);
  }
}
function result(mode: "full" | "affected", reason: string, browser: boolean, responsive: boolean, storybook: boolean) {
  const browserMatrix: Row[] = [];
  if (browser) {
    for (const [project, serverSet] of [["fresh-install", "fresh"], ["tunes", "tunes"], ["tunes-unseeded", "tunes-unseeded"]] as const) {
      browserMatrix.push({ name: serverSet, serverSet, projects: [project], shard: null });
    }
    const projects = [...seededLegacy, ...features];
    for (let i = 1; i <= 7; i++) browserMatrix.push({ name: `seeded-shard-${i}`, serverSet: "seeded", projects, shard: `${i}/7` });
  }
  return { mode, reason, browserMatrix, seedDatabase: browser, nativeWebgpu: browser, responsive, storybook };
}
function full(reason: string) {
  return result("full", reason, true, true, true);
}
function command(args: string[]) {
  const process = Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (process.exitCode !== 0) throw new Error(`${args[0]} failed: ${process.stderr.toString().trim()}`);
  return process.stdout.toString();
}
function validateCoverage(base: string, head: string) {
  const changed = command(["git", "diff", "--name-only", "--no-renames", "-z", `${base}...${head}`])
    .split("\0").filter(Boolean)
    .filter((path) => !path.startsWith("docs/") || !path.endsWith(".md"));
  if (!changed.length) return false;
  if (command(["git", "rev-parse", "HEAD"]).trim() !== head) throw new Error("coverage inventory requires head checkout");
  for (const path of changed) {
    try {
      command(["git", "cat-file", "-e", `${head}:${path}`]);
    } catch {
      throw new Error(`deleted or renamed input requires full verification: ${path}`);
    }
  }
  const dry = JSON.parse(command(["bunx", "--no-install", "turbo", "run", ...taskNames, "--dry=json"]));
  if (!Array.isArray(dry.tasks)) throw new Error("malformed Turbo task inventory");
  const tasks = new Map<string, { directory: string; inputs: Record<string, string>; dependencies: string[] }>();
  for (const task of dry.tasks) {
    if (!task || typeof task.taskId !== "string" || tasks.has(task.taskId) ||
        typeof task.directory !== "string" || !task.inputs || typeof task.inputs !== "object" || Array.isArray(task.inputs) ||
        !Object.values(task.inputs).every((value) => typeof value === "string") ||
        !Array.isArray(task.dependencies) || !task.dependencies.every((value: unknown) => typeof value === "string")) {
      throw new Error("malformed Turbo task inventory");
    }
    tasks.set(task.taskId, task);
  }
  const pending = [
    ...features.map((feature) => `@raceiq/${feature}#e2e:impact`),
    ...taskNames.slice(1).map((name) => `raceiq-e2e#${name}`),
  ];
  const visited = new Set<string>();
  const inputs = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const task = tasks.get(id);
    if (!task) throw new Error(`missing Turbo task inventory: ${id}`);
    for (const path of Object.keys(task.inputs)) inputs.add(relative(root, resolve(root, task.directory, path)));
    pending.push(...task.dependencies);
  }
  for (const path of changed) {
    if (!inputs.has(path)) throw new Error(`no verification task covers changed input: ${path}`);
  }
  return true;
}
function select(base: string | undefined, head: string | undefined) {
  try {
    validateImpactTasks();
    if (command(["git", "rev-parse", "--is-shallow-repository"]).trim() !== "false") throw new Error("shallow repository");
    if (!base || !head) throw new Error("affected mode requires both refs");
    const resolve = (ref: string) => command(["git", "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
    const baseCommit = resolve(base);
    const headCommit = resolve(head);
    if (baseCommit === headCommit) throw new Error("equal refs");
    command(["git", "merge-base", baseCommit, headCommit]);
    const hasVerificationInputs = validateCoverage(baseCommit, headCommit);
    const raw = command(["bunx", "--no-install", "turbo", "query", "affected", "--tasks", ...taskNames, "--base", baseCommit, "--head", headCommit]);
    const data = JSON.parse(raw)?.data?.affectedTasks;
    if (!data || !Array.isArray(data.items) || data.length !== data.items.length) throw new Error("malformed Turbo query response");
    let browser = false;
    let responsive = false;
    const packages = workspaceNames();
    let storybook = false;
    for (const item of data.items) {
      if (!item || typeof item.name !== "string" || typeof item.fullName !== "string" || typeof item.package?.name !== "string" || !packages.has(item.package.name) || item.fullName !== `${item.package.name}#${item.name}` || (item.name !== "transit" && !taskNames.includes(item.name))) throw new Error("unknown Turbo task");
      if (item.name === "transit") continue;
      if (item.name === "e2e:impact" && !packages.get(item.package.name)) continue;
      if (item.name === "e2e:impact" && item.package.name.startsWith("@raceiq/")) {
        const feature = item.package.name.slice("@raceiq/".length);
        if (features.includes(feature as typeof features[number])) {
          browser = true;
          continue;
        }
      } else if (item.package.name === "raceiq-e2e") {
        if (item.name.startsWith("browser:")) browser = true;
        else if (item.name === "visual:responsive:impact") responsive = true;
        else if (item.name === "visual:storybook:impact") storybook = true;
        else throw new Error(`unknown impact task owner: ${item.fullName}`);
        continue;
      }
      throw new Error(`unknown impact task owner: ${item.fullName}`);
    }
    if (hasVerificationInputs && !browser && !responsive && !storybook) {
      throw new Error("changed verification inputs produced no mapped tasks");
    }
    return result("affected", "validated affected task query", browser, responsive, storybook);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Affected verification: ${reason}; selecting full inventory`);
    return full(reason);
  }
}
try {
  inventory();
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || args[i + 1] === undefined || args[i + 1]?.startsWith("--") || options.has(args[i])) throw new Error("Expected --mode <full|affected> [--base <ref> --head <ref>]");
    options.set(args[i]!, args[i + 1]!);
  }
  if ([...options.keys()].some((key) => !["--mode", "--base", "--head"].includes(key))) throw new Error("Unknown selector option");
  const mode = options.get("--mode");
  if (mode !== "full" && mode !== "affected") throw new Error("Invalid selector mode");
  console.log(JSON.stringify(mode === "full" ? full("full mode requested") : select(options.get("--base"), options.get("--head"))));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
