const root = new URL("../..", import.meta.url).pathname;
const suites = [
  { name: "unit", args: ["run", "test:unit"] },
  { name: "integration", args: ["run", "test:integration"] },
  { name: "recording E2E", args: ["run", "test:e2e:recordings"] },
  { name: "Playwright E2E", args: ["run", "--cwd", "playwright", "test"], env: { PW_SERVER_SET: "all" } },
];
const failures: string[] = [];

for (const suite of suites) {
  console.log(`\n=== Running ${suite.name} tests ===`);
  const result = Bun.spawnSync([process.execPath, ...suite.args], {
    cwd: root,
    env: { ...process.env, ...suite.env },
    stdout: "inherit",
    stderr: "inherit",
  });
  if (result.exitCode !== 0) failures.push(`${suite.name} (exit ${result.exitCode ?? "signal"})`);
}

if (failures.length > 0) {
  console.error(`\nFailed test suites: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nAll test suites passed.");
