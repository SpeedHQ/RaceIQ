const watcher = Bun.spawn(["bun", "scripts/dev/paraglide-dev.ts"], {
  cwd: process.cwd(),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const vite = Bun.spawn(["portless", "raceiq", "bun", "run", "dev"], {
  cwd: `${process.cwd()}/client`,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await vite.exited;
watcher.kill();
await watcher.exited;
process.exit(exitCode);
export {};
