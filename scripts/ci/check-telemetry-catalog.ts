import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const generatedPath = "shared/telemetry/catalog/generated/telemetry-catalog.generated.json";
const legacyPath = "shared/telemetry-catalog.generated.json";
const baseRef = process.env.GITHUB_BASE_REF;
const isPullRequest = process.env.GITHUB_EVENT_NAME === "pull_request";

function run(command: string[], inherit = true) {
  return Bun.spawnSync(command, inherit ? { stdout: "inherit", stderr: "inherit" } : {});
}

let args = ["run", "telemetry:catalog:check"];
if (isPullRequest && baseRef) {
  const fetchResult = run(["git", "fetch", "--no-tags", "--depth=1", "origin", `${baseRef}:refs/remotes/origin/${baseRef}`]);
  if (fetchResult.exitCode !== 0) process.exit(fetchResult.exitCode);

  let baseline = run(["git", "show", `origin/${baseRef}:${generatedPath}`], false);
  if (baseline.exitCode !== 0) {
    baseline = run(["git", "show", `origin/${baseRef}:${legacyPath}`], false);
  }

  if (baseline.exitCode === 0) {
    const baselinePath = join(process.env.RUNNER_TEMP ?? tmpdir(), "telemetry-catalog-baseline.json");
    const baselineText = new TextDecoder().decode(baseline.stdout);
    writeFileSync(baselinePath, baselineText);
    args = [...args, "--baseline", baselinePath];
  } else {
    console.log("Base branch has no telemetry catalog; checking current artifacts without a compatibility baseline.");
  }
}

const result = run(["bun", ...args]);
process.exit(result.exitCode);
