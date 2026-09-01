import { cpSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";

const env = process.env;
const pr = env.PR!;
const runId = env.RUN_ID!;
const repo = env.REPO!;
const branch = env.PREVIEW_BRANCH!;
const subdir = `pr-${pr}/${runId}`;
const remote = `https://x-access-token:${env.GH_TOKEN}@github.com/${repo}.git`;
const run = (args: string[], cwd?: string) => execFileSync(args[0], args.slice(1), { cwd, stdio: "inherit" });
rmSync("preview-repo", { recursive: true, force: true });
try { run(["git", "clone", "--depth", "1", "--single-branch", "--branch", branch, remote, "preview-repo"]); }
catch { run(["git", "clone", "--depth", "1", remote, "preview-repo"]); run(["git", "checkout", "--orphan", branch], "preview-repo"); run(["git", "rm", "-rf", "."], "preview-repo"); }
const target = `preview-repo/${subdir}`;
mkdirSync(target, { recursive: true });
for (const file of new Bun.Glob("pr-preview/*-{before,after,diff}.png").scanSync(".")) cpSync(file, `${target}/${file.split("/").pop()}`);
run(["git", "add", subdir], "preview-repo");
run(["git", "-c", "user.name=github-actions[bot]", "-c", "user.email=github-actions[bot]@users.noreply.github.com", "commit", "-m", `preview: PR #${pr} dashboard screenshots (run ${runId})`], "preview-repo");
run(["git", "push", "origin", branch], "preview-repo");
await Bun.write(env.GITHUB_OUTPUT!, `subdir=${subdir}\n`);
