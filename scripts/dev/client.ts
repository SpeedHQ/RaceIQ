const serverTarget = process.env.PROXY_TARGET ?? `http://localhost:${process.env.SERVER_PORT ?? "3117"}`;

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${serverTarget}/api/runtime/features`);
      if (response.ok) return;
    } catch {}
    await Bun.sleep(100);
  }
  throw new Error(`Development server did not become ready at ${serverTarget}`);
}

const prepare = Bun.spawn(["bun", "scripts/dev/paraglide-dev.ts", "--once"], {
  cwd: process.cwd(),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});
const prepareExitCode = await prepare.exited;
if (prepareExitCode !== 0) process.exit(prepareExitCode);

await waitForServer();

const watcher = Bun.spawn(["bun", "scripts/dev/paraglide-dev.ts"], {
  cwd: process.cwd(),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const vite = Bun.spawn(["portless", "run", "--name", process.env.RACEIQ_DEV_PORTLESS_NAME ?? "raceiq", "bun", "run", "dev"], {
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
