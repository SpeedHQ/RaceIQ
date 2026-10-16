#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const turbo = resolve(root, "node_modules/turbo/bin/turbo");
const lanes = [
  { name: "fresh", server_set: "fresh", projects: ["fresh-install"], runs_on: ["mars-windows-x64-2vcpu-15g", "mars-macos-arm64-2vcpu-10g", "mars-ubuntu-arm64-2vcpu-10g", "mars-retry-3"] },
  { name: "tunes", server_set: "tunes", projects: ["tunes"], runs_on: ["mars-windows-x64-2vcpu-15g", "mars-macos-arm64-2vcpu-10g", "mars-ubuntu-arm64-2vcpu-10g", "mars-retry-3"] },
  { name: "tunes-unseeded", server_set: "tunes-unseeded", projects: ["tunes-unseeded"], runs_on: ["mars-windows-x64-2vcpu-15g", "mars-macos-arm64-2vcpu-10g", "mars-ubuntu-arm64-2vcpu-10g", "mars-retry-3"] },
];
const seeded = ["seeded-e2e", "seeded-routes", "seeded-imports", "mobile-device", "tablet-device"];
const tasks: Record<string, string> = {
  "fresh-install": "test:e2e:fresh",
  tunes: "test:e2e:tunes",
  "tunes-unseeded": "test:e2e:tunes-unseeded",
  "seeded-e2e": "test:e2e:seeded",
  "seeded-routes": "test:e2e:routes",
  "seeded-imports": "test:e2e:imports",
  "mobile-device": "test:e2e:devices",
  "tablet-device": "test:e2e:devices",
};
const projectTaskNames = [...new Set(Object.values(tasks))];
type MatrixEntry = {
  name: string;
  server_set: string;
  projects: string;
  runs_on: string;
  shard?: string;
};
type TurboDryTask = {
  taskId: string;
  cache: { local: boolean; remote: boolean };
};
type TurboDryJson = { tasks: TurboDryTask[] };
const node = Bun.which("node");
if (!node) fail("Node executable not found on PATH");
const nodeVersionResult = Bun.spawnSync([node, "--version"], { cwd: root, stdout: "pipe", stderr: "pipe" });
const actualNodeVersion = nodeVersionResult.exitCode === 0 ? nodeVersionResult.stdout.toString().trim() : "";
if (!/^v\d+\.\d+\.\d+(?:[-+].*)?$/.test(actualNodeVersion)) fail("Could not determine actual Node version");
const runtimeSalt = [process.platform, process.arch, Bun.version, actualNodeVersion].join("-");
const env: NodeJS.ProcessEnv = { ...process.env, RACEIQ_E2E_RUNTIME: runtimeSalt };

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}
function projectFlags(value = env.PLAYWRIGHT_PROJECTS ?? ""): string[] {
  const flags = value.trim().split(/\s+/).filter(Boolean);
  const projects: string[] = [];
  for (const flag of flags) {
    const match = /^--project=(.+)$/.exec(flag);
    if (!match || !tasks[match[1]]) fail(`Unsupported Playwright project flag: ${flag}`);
    projects.push(match[1]);
  }
  if (projects.length === 0) fail("PLAYWRIGHT_PROJECTS must contain at least one --project=<name> flag");
  if (projects.includes("mobile-device") !== projects.includes("tablet-device")) {
    fail("The devices task requires both --project=mobile-device and --project=tablet-device");
  }
  return [...new Set(projects)];
}
function validateShard(value = env.PLAYWRIGHT_SHARD): string | undefined {
  if (!value) return undefined;
  const match = /^(\d+)\/(\d+)$/.exec(value);
  if (!match || !Number.isSafeInteger(Number(match[1])) || !Number.isSafeInteger(Number(match[2])) || +match[1] < 1 || +match[2] < 1 || +match[1] > +match[2]) fail(`Invalid PLAYWRIGHT_SHARD: ${value}`);
  return value;
}
function validateRefs(): boolean {
  const refs = [env.TURBO_SCM_BASE, env.TURBO_SCM_HEAD];
  return refs.every((ref) => !!ref && Bun.spawnSync(["git", "rev-parse", "--verify", `${ref}^{commit}`], { cwd: root, stdout: "ignore", stderr: "ignore" }).exitCode === 0);
}
async function run(args: string[], options: { capture?: boolean; cache?: string } = {}): Promise<{ code: number; stdout: string }> {
  const cli = [process.execPath, turbo, ...args];
  const separator = cli.indexOf("--");
  cli.splice(separator < 0 ? cli.length : separator, 0, `--cache=${options.cache ?? "local:rw"}`);
  const child = Bun.spawn(cli, { cwd: root, env, stdout: options.capture ? "pipe" : "inherit", stderr: "inherit" });
  let stdout = "";
  if (options.capture && child.stdout) stdout = await new Response(child.stdout).text();
  const code = await child.exited;
  return { code, stdout };
}
function taskNames(projects: string[]): string[] { return [...new Set(projects.map((project) => tasks[project]))]; }
function turboArgs(names: string[], options: string[] = [], dryRun = false): string[] {
  const separator = options.indexOf("--");
  const flags = separator < 0 ? [...options] : options.slice(0, separator);
  const forwarded = separator < 0 ? [] : options.slice(separator);
  const serialFlags: string[] = [];
  for (let index = 0; index < flags.length; index++) {
    const flag = flags[index];
    if (flag === "--concurrency" || flag.startsWith("--concurrency=")) {
      const value = flag === "--concurrency" ? flags[++index] : flag.slice("--concurrency=".length);
      if (value !== "1") fail("E2E tasks share servers and require --concurrency=1");
    } else serialFlags.push(flag);
  }
  const continueFlag = serialFlags.some((flag) => flag === "--continue" || flag.startsWith("--continue=")) ? [] : ["--continue=always"];
  return ["run", ...names, "--filter=raceiq-e2e", ...serialFlags, "--concurrency=1", ...continueFlag, ...(dryRun ? ["--dry=json"] : []), ...forwarded];
}
function dryTasks(text: string): TurboDryTask[] {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { fail("Turbo --dry=json returned invalid JSON"); }
  if (!parsed || typeof parsed !== "object" || !Array.isArray((parsed as TurboDryJson).tasks)) fail("Turbo --dry=json missing tasks array");
  const nodes = (parsed as TurboDryJson).tasks;
  for (const node of nodes) if (!node || typeof node.taskId !== "string" || !node.taskId.includes("#") || !node.cache || typeof node.cache.local !== "boolean" || typeof node.cache.remote !== "boolean") fail("Turbo --dry=json returned malformed task/cache data");
  return nodes;
}
async function dry(names: string[], options: string[] = [], cache = "local:rw"): Promise<{ selected: string[]; pending: string[] }> {
  const result = await run(turboArgs(names, options, true), { capture: true, cache });
  if (result.code !== 0) fail(`Turbo dry-run failed (exit ${result.code})`);
  const nodes = dryTasks(result.stdout).filter((node) => projectTaskNames.includes(node.taskId.split("#").at(-1)!));
  return {
    selected: [...new Set(nodes.map((node) => node.taskId.split("#").at(-1)!))],
    pending: [...new Set(nodes.filter((node) => !node.cache.local && !node.cache.remote).map((node) => node.taskId.split("#").at(-1)!))],
  };
}
async function output(values: Record<string, string>): Promise<void> {
  if (!env.GITHUB_OUTPUT) fail("GITHUB_OUTPUT is required for this command");
  await appendFile(env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
}

const [command, ...args] = process.argv.slice(2);
if (command === "plan") {
  if (args.length) fail("plan accepts no arguments");
  const pr = env.GITHUB_EVENT_NAME === "pull_request";
  const affected = pr && validateRefs();
  let chosen = affected ? [] as string[] : Object.keys(tasks);
  if (affected) {
    const selected = await dry(projectTaskNames, ["--affected"]);
    chosen = selected.selected.flatMap((task) => Object.entries(tasks).filter(([, mapped]) => mapped === task).map(([project]) => project));
  } else if (pr && !validateRefs()) {
    delete env.TURBO_SCM_BASE;
    delete env.TURBO_SCM_HEAD;
  }
  const matrix: MatrixEntry[] = [];
  for (const lane of lanes) if (chosen.includes(lane.projects[0])) matrix.push({ ...lane, projects: `--project=${lane.projects[0]}`, runs_on: JSON.stringify(lane.runs_on) });
  const seededProjects = seeded.filter((project) => chosen.includes(project));
  if (seededProjects.length) for (let shard = 1; shard <= 7; shard++) matrix.push({ name: `seeded-shard-${shard}`, server_set: "seeded", projects: seededProjects.map((p) => `--project=${p}`).join(" "), shard: `${shard}/7`, runs_on: JSON.stringify(["mars-windows-x64-4vcpu-15g", "mars-macos-arm64-2vcpu-10g", "mars-ubuntu-arm64-2vcpu-10g", "mars-retry-3"]) });
  await output({ matrix: JSON.stringify({ include: matrix }), "has-tests": String(matrix.length > 0), "needs-seed": String(seededProjects.length > 0) });
  console.log(`Planned ${matrix.length} Playwright matrix entries${pr && !affected ? " (full: SCM refs unavailable)" : ""}.`);
} else if (command === "probe" || command === "run") {
  if (args.length) fail(`${command} accepts no arguments`);
  const projects = projectFlags();
  const shard = validateShard();
  const names = taskNames(projects);
  const options = shard ? ["--", `--shard=${shard}`] : [];
  if (command === "probe") {
    const { selected, pending } = await dry(names, options);
    if (names.some((name) => !selected.includes(name))) fail("Turbo cache probe omitted a requested suite");
    await output({ "needs-run": String(pending.length > 0) });
    console.log(`Selected ${names.length} suite task(s); ${pending.length} require execution.`);
  } else {
    const result = await run(turboArgs(names, options));
    process.exit(result.code);
  }
} else if (command === "local") {
  const separator = args.indexOf("--");
  const tokens = separator < 0 ? args : args.slice(0, separator);
  const forwarded = separator < 0 ? [] : args.slice(separator + 1);
  const names: string[] = [];
  let options: string[] = [];
  for (const token of tokens) {
    if (projectTaskNames.includes(token)) names.push(token);
    else if (token === "--list" || token.startsWith("--list=") || token === "--ui") forwarded.push(token);
    else options.push(token);
  }
  if (!names.length) names.push(...projectTaskNames);
  const dryFlags = ["--dry", "--dry-run", "--dry=json", "--dry-run=json"];
  const dryRequested = options.some((option) => dryFlags.includes(option));
  options = options.filter((option) => !dryFlags.includes(option));
  if (options.includes("--affected") && !validateRefs()) {
    console.error("Affected SCM refs unavailable; running full suite selection.");
    options = options.filter((option) => option !== "--affected");
    delete env.TURBO_SCM_BASE;
    delete env.TURBO_SCM_HEAD;
  }
  const only = options.includes("--only");
  const listing = forwarded.some((option) => option === "--list" || option.startsWith("--list="));
  const bypassCache = only || listing || forwarded.includes("--ui");
  let cache = "local:rw";
  options = options.filter((option, index) => {
    if (option.startsWith("--cache=")) {
      cache = option.slice("--cache=".length);
      return false;
    }
    if (option === "--cache") {
      cache = options[index + 1] ?? fail("--cache requires a value");
      return false;
    }
    return options[index - 1] !== "--cache";
  });
  if (bypassCache) cache = "local:,remote:";
  const taskOptions = [...options, ...(forwarded.length ? ["--", ...forwarded] : [])];
  if (dryRequested) {
    const result = await run(turboArgs(names, taskOptions, true), { cache });
    process.exit(result.code);
  }
  const { selected, pending } = await dry(names, taskOptions, cache);
  if ((options.includes("--force") ? selected.length : pending.length) && !only && !listing && env.E2E_SERVER_MODE !== "dev") {
    const build = await run(["run", "@raceiq/tooling-build#build"]);
    if (build.code !== 0) process.exit(build.code);
  }
  const result = await run(turboArgs(names, taskOptions), { cache });
  process.exit(result.code);
} else {
  fail("Usage: playwright-turbo.ts <plan|probe|run|local>");
}
