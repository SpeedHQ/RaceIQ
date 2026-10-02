import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { selectGameTests } from "./select-game-tests";

const root = resolve(import.meta.dir, "../..");
const outputPath = process.env.GITHUB_OUTPUT;
const tempDir = process.env.RUNNER_TEMP;
if (!outputPath || !tempDir) throw new Error("GITHUB_OUTPUT and RUNNER_TEMP are required");

function git(args: string[]): { code: number; stdout: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: result.stdout.toString() };
}

const event = process.env.GITHUB_EVENT_NAME;
let base: string | undefined;
if (event === "pull_request" || event === "pull_request_target") base = process.env.PR_BASE_SHA;
else if (event === "push") base = process.env.PUSH_BEFORE_SHA;
else if (event === "workflow_dispatch") base = process.env.INPUT_BASE_REF;

let changed: string[] = [];
let fallbackReason: string | undefined;
const head = git(["rev-parse", "--verify", "HEAD^{commit}"]);
if (!base || base === "0000000000000000000000000000000000000000") {
  fallbackReason = "missing diff base";
} else if (head.code !== 0) {
  fallbackReason = "missing checked-out HEAD";
} else {
  const resolvedBase = git(["rev-parse", "--verify", `${base}^{commit}`]);
  if (resolvedBase.code !== 0) {
    fallbackReason = `unresolvable diff base: ${base}`;
  } else {
    const diff = git(["diff", "--name-status", "--no-renames", resolvedBase.stdout.trim(), head.stdout.trim()]);
    if (diff.code !== 0) {
      fallbackReason = `git diff failed for base ${base}`;
    } else {
      for (const line of diff.stdout.split(/\r?\n/).filter(Boolean)) {
        const [status, path] = line.split("\t", 2);
        if (!status || !path) {
          fallbackReason = "could not parse git diff status";
          break;
        }
        if (status.startsWith("D") || status.startsWith("R")) {
          fallbackReason = `deleted or renamed path: ${path}`;
          break;
        }
        changed.push(path);
      }
    }
  }
}

const selection = await selectGameTests(root, fallbackReason ? ["__invalid_diff_base__"] : changed);
const reason = fallbackReason ?? selection.fullReason ?? "classified diff";
mkdirSync(tempDir, { recursive: true });
const filesPaths = {
  unit: resolve(tempDir, "raceiq-unit-tests.json"),
  tooling: resolve(tempDir, "raceiq-tooling-tests.json"),
  integration: resolve(tempDir, "raceiq-integration-tests.json"),
};
writeFileSync(filesPaths.unit, JSON.stringify(selection.unit));
writeFileSync(filesPaths.tooling, JSON.stringify(selection.tooling));
writeFileSync(filesPaths.integration, JSON.stringify(selection.integration));
const outputs = [
  `run_unit=${selection.unit.length > 0}`,
  `unit_files=${filesPaths.unit}`,
  `run_tooling=${selection.tooling.length > 0}`,
  `tooling_files=${filesPaths.tooling}`,
  `run_integration=${selection.integration.length > 0}`,
  `integration_files=${filesPaths.integration}`,
  `games=${selection.games.join(",")}`,
  `reason=${reason.replace(/[\r\n]/g, " ")}`,
];
appendFileSync(outputPath, `${outputs.join("\n")}\n`);
console.log(outputs.join("\n"));
