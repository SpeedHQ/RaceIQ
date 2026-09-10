export {};

const version = process.argv[2] ?? "";
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error(`Release version must match MAJOR.MINOR.PATCH: ${version || "<missing>"}`);
}

const child = Bun.spawn([
  "bun",
  "build",
  "--compile",
  "--target=bun-windows-x64",
  "--windows-icon=assets/raceiq.ico",
  "--windows-title=RaceIQ",
  "--windows-publisher=SpeedHQ",
  "--windows-description=RaceIQ",
  `--windows-version=${version}`,
  "--define",
  'process.env.NODE_ENV="production"',
  "server/bootstrap.ts",
  "--outfile",
  "dist/raceiq.exe",
], {
  cwd: process.cwd(),
  env: { ...process.env, NODE_ENV: "production" },
  stdout: "inherit",
  stderr: "inherit",
});
const exitCode = await child.exited;
if (exitCode !== 0) throw new Error(`Release server compile failed with exit code ${exitCode}`);
