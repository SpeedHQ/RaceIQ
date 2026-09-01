export function releaseCompileArgs(version: string): string[] {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`Release version must match MAJOR.MINOR.PATCH: ${version || "<missing>"}`);
  }

  return [
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
    "--define",
    'process.env.RACEIQ_FEATURE_F1_EXPERIMENTS="false"',
    "--define",
    'process.env.RACEIQ_FEATURE_IRACING_ADAPTER="false"',
    "server/bootstrap.ts",
    "--outfile",
    "dist/raceiq.exe",
  ];
}

if (import.meta.main) {
  const command = releaseCompileArgs(process.argv[2] ?? "");
  const child = Bun.spawn(command, {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: "production" },
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) throw new Error(`Release server compile failed with exit code ${exitCode}`);
}
