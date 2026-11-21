import { appendFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const [task, ...args] = Bun.argv.slice(2);
const categories: Record<string, "browserMatrix" | "responsive" | "storybook" | "utility"> = {
  "ci:browser": "browserMatrix",
  "ci:responsive-current": "responsive",
  "ci:responsive-base": "responsive",
  "ci:storybook-base": "storybook",
  "ci:storybook-current": "storybook",
  "ci:check-shards": "utility",
  "ci:check-locales": "utility",
  "ci:check-db-upgrade": "utility",
  "ci:check-telemetry": "utility",
};
const category = categories[task ?? ""];
if (!task || !category) throw new Error(`Unknown CI verification task: ${task}`);

const env = { ...process.env };
let affected = env.CI_VERIFICATION_MODE === "affected";
let selected = true;
if (affected) {
  const base = env.TURBO_SCM_BASE ?? "";
  const head = env.TURBO_SCM_HEAD ?? "";
  const shallow = Bun.spawnSync(["git", "rev-parse", "--is-shallow-repository"], { cwd: root, stdout: "pipe", stderr: "ignore" });
  const selector = Bun.spawnSync(["bun", "scripts/ci/affected-verification.ts", "--mode", "affected", "--base", base, "--head", head], { cwd: root, env, stdout: "pipe", stderr: "inherit" });
  try {
    const selection = JSON.parse(selector.stdout.toString());
    affected = shallow.exitCode === 0 && shallow.stdout.toString().trim() === "false" && selector.exitCode === 0 && selection.mode === "affected" && Array.isArray(selection.browserMatrix) && typeof selection.responsive === "boolean" && typeof selection.storybook === "boolean";
    if (affected) {
      const dry = Bun.spawnSync(["bunx", "--no-install", "turbo", "run", task, "--filter=raceiq-e2e", "--affected", "--dry=json"], { cwd: root, env, stdout: "pipe", stderr: "inherit" });
      const inventory = JSON.parse(dry.stdout.toString());
      if (dry.exitCode !== 0 || !Array.isArray(inventory.tasks)) throw new Error("invalid Turbo dry-run output");
      selected = inventory.tasks.some((entry: { taskId?: string }) => entry.taskId === `raceiq-e2e#${task}`);
      const expected = category === "utility" ? selection.browserMatrix.length > 0 || selection.responsive || selection.storybook : category === "browserMatrix" ? selection.browserMatrix.length > 0 : selection[category];
      if (expected && !selected) throw new Error("affected verification task missing from Turbo selection");
    }
  } catch (error) {
    console.error(`Affected verification selection failed: ${error}`);
    affected = false;
  }
  if (!affected) selected = true;
  if (!affected) console.error("Affected verification unavailable; running full browser task.");
}
if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, `selected=${selected}\n`);
const command = ["bunx", "--no-install", "turbo", "run", task, "--filter=raceiq-e2e", "--env-mode=loose", ...(affected ? ["--affected"] : []), ...(args.length ? ["--", ...args] : [])];
const child = Bun.spawn(command, { cwd: root, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
process.exitCode = await child.exited;
