import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const features = ["tracks-catalogue", "cars-catalogue", "lap-replay", "sessions-page", "session-analyse"];
const seeded = ["seeded-e2e", "seeded-routes", "seeded-imports", ...features];
const independent = [["fresh-install", "fresh"], ["tunes", "tunes"], ["tunes-unseeded", "tunes-unseeded"]] as const;
const projects = [...independent.map(([project]) => project), ...seeded, "lap-replay-webgpu"];
const known = [...projects, "tunes-setup", "seeded-setup", "record-demo"];
const utilities = {
  shards: "ci:check-shards",
  locales: "ci:check-locales",
  dbUpgrade: "ci:check-db-upgrade",
  telemetry: "ci:check-telemetry",
} as const;
const browserTask = (name: string) => `raceiq-e2e#${name}`;
const jobs = {
  build: browserTask("verify:build:impact"),
  desktop: browserTask("verify:desktop:impact"),
  responsive: browserTask("visual:responsive:impact"),
  storybook: browserTask("visual:storybook:impact"),
} as const;
const projectTasks = new Map([
  ...features.map((name) => [name, `@raceiq/${name}#e2e:impact`] as const),
  ...[...independent.map(([project, server]) => [project, server] as const),
    ...seeded.slice(0, 3).map((name) => [name, name] as const),
    ["lap-replay-webgpu", "webgpu"] as const,
  ].map(([project, task]) => [project, browserTask(`browser:${task}:impact`)] as const),
]);
const benchmarkTask = "@raceiq/backend#bench:replay";
const mapped = new Set([...projectTasks.values(), ...Object.values(jobs), ...Object.values(utilities).map(browserTask), benchmarkTask]);
const taskNames = [...new Set([...mapped].map((id) => id.split("#")[1]!))];
const ordinaryTasks = ["test:unit", "test:tooling", "test:integration", "test:e2e:recordings", "lint", "typecheck"];
type Row = { name: string; serverSet: string; projects: string[]; shard: string };
type Scope = "all" | "pr" | "non-pr";
function validateProjects(cwd = root) {
  const available: unknown = JSON.parse(command([
    process.execPath,
    "-e",
    `import { createProjects } from "./playwright/config/projects";
import { runtime } from "./playwright/config/runtime";
console.log(JSON.stringify(createProjects(runtime).map((project) => project.name)));`,
  ], cwd));
  if (!Array.isArray(available) || !available.every((name): name is string => typeof name === "string") ||
      available.length !== known.length || new Set(available).size !== known.length || known.some((name) => !available.includes(name))) {
    throw new Error("Playwright project inventory does not match selector");
  }
}
function plan(mode: "full" | "affected", reason: string, selected: Set<string>, scope: Scope, head: string, base = "") {
  const browserMatrix: Row[] = [];
  const includes = (project: string) => selected.has(projectTasks.get(project)!);
  if (scope !== "non-pr") {
    for (const [project, serverSet] of independent) {
      if (includes(project)) browserMatrix.push({ name: serverSet, serverSet, projects: [project], shard: "" });
    }
    const seededProjects = seeded.filter(includes);
    if (seededProjects.length) {
      for (let i = 1; i <= 7; i++) browserMatrix.push({ name: `seeded-shard-${i}`, serverSet: "seeded", projects: seededProjects, shard: `${i}/7` });
    }
  }
  const nativeWebgpu = scope !== "non-pr" && includes("lap-replay-webgpu");
  const seedDatabase = nativeWebgpu || browserMatrix.some((row) => row.serverSet === "seeded");
  const build = selected.has(jobs.build);
  const desktop = selected.has(jobs.desktop);
  const responsive = scope !== "non-pr" && selected.has(jobs.responsive);
  const storybook = scope !== "non-pr" && selected.has(jobs.storybook);
  const benchmark = scope !== "non-pr" && selected.has(benchmarkTask);
  const checks = Object.fromEntries(Object.entries(utilities).map(([key, task]) => [
    key, (key !== "dbUpgrade" || scope !== "non-pr") && selected.has(browserTask(task)),
  ]));
  const expected = {
    build,
    "macos-desktop": desktop,
    test: true,
    changelog: scope === "pr",
    "playwright-e2e": browserMatrix.length > 0 || nativeWebgpu,
    "visual-regression": responsive || storybook,
  };
  const browser = { matrix: browserMatrix, seedDatabase, nativeWebgpu };
  return {
    mode, reason, head, base, build, desktop, browserMatrix, seedDatabase, nativeWebgpu, benchmark,
    responsive, storybook, checks, expected, browser,
    artifacts: {
      seed: seedDatabase ? "playwright-seeded-database" : "",
      paraglide: build && scope === "pr" ? "raceiq-paraglide" : "",
      previews: [responsive && "responsive", storybook && "storybook"].filter(Boolean),
    },
  };
}

function command(args: string[], cwd = root) {
  const child = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
  if (child.exitCode !== 0) throw new Error(`${args[0]} failed: ${child.stderr.toString().trim()}`);
  return child.stdout.toString();
}

function revisionInventory(cwd: string, base: string, head: string, paths: string[]) {
  const turbo = (args: string[]) => command(["bunx", "--no-install", "turbo", ...args], cwd);
  const configured = JSON.parse(readFileSync(join(cwd, "playwright/turbo.json"), "utf8")).tasks;
  const backendTasks = JSON.parse(readFileSync(join(cwd, "apps/backend/turbo.json"), "utf8")).tasks;
  for (const id of mapped) {
    const [owner, task] = id.split("#") as [string, string];
    if (owner === "raceiq-e2e" && !configured[task]) throw new Error(`missing task configuration: ${id}`);
    if (id === benchmarkTask && !backendTasks[task]) throw new Error(`missing task configuration: ${id}`);
    if (id !== benchmarkTask && owner !== "raceiq-e2e" && !existsSync(join(cwd, "packages", owner.slice("@raceiq/".length), "turbo.json"))) {
      throw new Error(`missing feature task configuration: ${id}`);
    }
  }
  const dry = JSON.parse(turbo(["run", ...taskNames, ...ordinaryTasks, "--dry=json"]));
  if (!Array.isArray(dry.tasks)) throw new Error("malformed Turbo task inventory");
  const inventory = new Map<string, { executable: boolean; dependencies: string[]; changed: string[] }>();
  const changedPaths = new Set(paths);
  for (const task of dry.tasks) {
    if (!task || typeof task.taskId !== "string" || inventory.has(task.taskId) ||
        typeof task.directory !== "string" || !task.inputs || typeof task.inputs !== "object" || Array.isArray(task.inputs) ||
        !Object.values(task.inputs).every((value) => typeof value === "string") ||
        !Array.isArray(task.dependencies) || !task.dependencies.every((value: unknown) => typeof value === "string")) {
      throw new Error("malformed Turbo task inventory");
    }
    const changed = [];
    for (const file of Object.keys(task.inputs)) {
      const path = relative(cwd, resolve(cwd, task.directory, file)).replaceAll("\\", "/");
      if (changedPaths.has(path)) changed.push(path);
    }
    inventory.set(task.taskId, { executable: typeof task.command === "string" && task.command !== "<NONEXISTENT>", dependencies: task.dependencies, changed });
  }
  const inputsFor = (roots: Iterable<string>) => {
    const inputs = new Set<string>();
    const pending = [...roots];
    const visited = new Set<string>();
    while (pending.length) {
      const id = pending.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const task = inventory.get(id);
      if (!task) throw new Error(`missing Turbo task inventory: ${id}`);
      for (const path of task.changed) inputs.add(path);
      pending.push(...task.dependencies);
    }
    return inputs;
  };
  const ciInputs = inputsFor(mapped);
  const ordinaryInputs = inputsFor([...inventory].filter(([id, task]) => task.executable && ordinaryTasks.includes(id.split("#")[1]!)).map(([id]) => id));
  for (const path of paths) {
    if (!ciInputs.has(path) && !ordinaryInputs.has(path)) throw new Error(`no verification task covers changed input: ${path}`);
  }
  const response = JSON.parse(turbo(["query", "affected", "--tasks", ...taskNames, "--base", base, "--head", head]));
  const data = response?.data?.affectedTasks;
  if (response.errors?.length || !data || !Array.isArray(data.items) || data.length !== data.items.length) {
    throw new Error("malformed Turbo query response");
  }
  const selected = new Set<string>();
  const seen = new Set<string>();
  for (const item of data.items) {
    if (!item || typeof item.name !== "string" || typeof item.package?.name !== "string" ||
        item.fullName !== `${item.package.name}#${item.name}` || !inventory.has(item.fullName) || seen.has(item.fullName)) {
      throw new Error(`unknown Turbo task: ${item?.fullName}`);
    }
    seen.add(item.fullName);
    if (mapped.has(item.fullName)) selected.add(item.fullName);
    else if (taskNames.includes(item.name) && inventory.get(item.fullName)?.executable) {
      throw new Error(`unknown impact task owner: ${item.fullName}`);
    }
  }
  for (const id of mapped) {
    if (!inputsFor([id]).size) selected.delete(id);
    else if (!selected.has(id)) throw new Error(`Turbo omitted an affected input consumer: ${id}`);
  }
  return selected;
}

function baseInventory(base: string, head: string, paths: string[]) {
  const temp = mkdtempSync(join(tmpdir(), "raceiq-verification-base-"));
  try {
    const cwd = join(temp, "tree");
    command(["git", "init", "--quiet", cwd]);
    const objects = command(["git", "rev-parse", "--path-format=absolute", "--git-path", "objects"]).trim();
    const checkoutPaths = command(["git", "ls-tree", "-r", "--name-only", "-z", base]).split("\0");
    const changed = new Set(paths);
    const needed = checkoutPaths.filter((path) => changed.has(path) ||
      /(?:^|\/)(?:package\.json|turbo\.json|\.gitignore|\.gitattributes)$/.test(path) ||
      path === "bun.lock" || path === "playwright/config/projects.ts" || path === "playwright/config/runtime.ts");
    writeFileSync(join(cwd, ".git", "objects", "info", "alternates"), `${objects}\n`);
    const archive = join(temp, "tree.tar");
    command(["git", "archive", `--output=${archive}`, base, "--", ...needed]);
    symlinkSync(join(root, "node_modules"), join(cwd, "node_modules"), "junction");
    command(["tar", "-xf", archive, "-C", cwd]);
    command(["git", "reset", "--mixed", base], cwd);
    validateProjects(cwd);
    return revisionInventory(cwd, base, head, paths);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function select(base: string | undefined, head: string | undefined, checkout: string, scope: Scope) {
  try {
    if (command(["git", "rev-parse", "--is-shallow-repository"]).trim() !== "false") throw new Error("shallow repository");
    if (!base || !head) throw new Error("affected mode requires both refs");
    const commit = (ref: string) => command(["git", "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim();
    const baseCommit = commit(base);
    const headCommit = commit(head);
    if (baseCommit === headCommit) throw new Error("equal refs");
    if (checkout !== headCommit) throw new Error("verification head does not match checkout");
    if (command(["git", "status", "--porcelain", "--untracked-files=no"]).trim()) throw new Error("checkout has tracked changes");
    const mergeBases = command(["git", "merge-base", "--all", baseCommit, headCommit]).trim().split("\n");
    if (mergeBases.length !== 1 || !mergeBases[0] || mergeBases[0] === headCommit) throw new Error("unusable merge base");
    const mergeBase = mergeBases[0];
    const diff = command(["git", "diff", "--name-status", "--no-renames", "-z", mergeBase, headCommit]).split("\0");
    const current: string[] = [];
    const previous: string[] = [];
    for (let i = 0; i < diff.length - 1; i += 2) {
      const [status, path] = [diff[i], diff[i + 1]];
      if (!path || !status || !["A", "D", "M", "T"].includes(status)) throw new Error("invalid Git change inventory");
      if (path === "UNRELEASED.md" || (path.startsWith("docs/") && path.endsWith(".md"))) continue;
      if (path.startsWith(".github/") || path.startsWith("scripts/ci/affected-verification") ||
          path === "turbo.json" || path === "bun.lock") throw new Error(`verification contract changed: ${path}`);
      if (status !== "D") current.push(path);
      if (status === "D" || status === "T" || (status === "M" && /(?:^|\/)(?:package|turbo)\.json$/.test(path))) previous.push(path);
    }
    const selected = current.length || previous.length ? revisionInventory(root, mergeBase, headCommit, current) : new Set<string>();
    if (previous.length) for (const id of baseInventory(mergeBase, headCommit, previous)) selected.add(id);
    return plan("affected", "validated affected task query", selected, scope, headCommit, baseCommit);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Affected verification: ${reason}; selecting full inventory`);
    return plan("full", reason, mapped, scope, checkout);
  }
}
try {
  validateProjects();
  const args = process.argv.slice(2);
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!args[i]?.startsWith("--") || args[i + 1] === undefined || args[i + 1]?.startsWith("--") || options.has(args[i])) throw new Error("Expected --mode <full|affected> [--base <ref> --head <ref>]");
    options.set(args[i]!, args[i + 1]!);
  }
  if ([...options.keys()].some((key) => !["--mode", "--base", "--head", "--scope"].includes(key))) throw new Error("Unknown selector option");
  const mode = options.get("--mode");
  if (mode !== "full" && mode !== "affected") throw new Error("Invalid selector mode");
  const scope = options.get("--scope") ?? "all";
  if (scope !== "all" && scope !== "pr" && scope !== "non-pr") throw new Error("Invalid verification scope");
  const checkout = command(["git", "rev-parse", "--verify", "HEAD"]).trim();
  const result = mode === "full" ? plan("full", "full mode requested", mapped, scope, checkout) :
    select(options.get("--base"), options.get("--head"), checkout, scope);
  const output = process.env.GITHUB_OUTPUT;
  if (output) writeFileSync(output, `plan=${JSON.stringify(result)}\n`, { flag: "a" });
  console.log(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
