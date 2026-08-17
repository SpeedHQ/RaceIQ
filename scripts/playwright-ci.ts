#!/usr/bin/env bun

const [command, ...commandArgs] = Bun.argv.slice(2);
const projectArgs = (Bun.env.PLAYWRIGHT_PROJECTS ?? "").trim().split(/\s+/).filter(Boolean);

if (!command) {
  console.error("Usage: bun scripts/playwright-ci.ts <playwright-command> [args...]");
  process.exit(2);
}

const playwrightArgs = [command, ...commandArgs, ...projectArgs];
const playwrightCli = Bun.resolveSync("@playwright/test/cli", process.cwd());
const nodeExecutable = Bun.which("node");

if (!nodeExecutable) {
  console.error("Node.js executable not found; Playwright requires Node.js 20 or newer.");
  process.exit(2);
}

const child = Bun.spawn([nodeExecutable, playwrightCli, ...playwrightArgs], {
  cwd: process.cwd(),
  env: Bun.env,
  stdout: "pipe",
  stderr: "pipe",
});

const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);

process.stdout.write(stdout);
process.stderr.write(stderr);

if (command === "test" && commandArgs.includes("--list")) {
  if (exitCode !== 0) process.exit(exitCode);
  if (!/Total:\s+[1-9]\d*\s+tests/.test(stdout)) {
    console.error(`No Playwright tests discovered for ${projectArgs.join(" ")}`);
    process.exit(1);
  }
}

process.exit(exitCode);
export {};
