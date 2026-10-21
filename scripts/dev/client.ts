import { join } from "node:path";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import { readDashboardHosts } from "./dashboard-network";

const serverTarget = process.env.PROXY_TARGET ?? `http://localhost:${process.env.SERVER_PORT ?? "3117"}`;

async function waitForServer(): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      // Setup and login must be reachable before application APIs are unlocked.
      const response = await fetch(`${serverTarget}/api/auth/status`);
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

const dashboardHosts = process.env.PROXY_TARGET
  ? ["localhost"]
  : readDashboardHosts(join(resolveDataDir(), process.env.RACEIQ_TEST_MODE === "1" ? "test.db" : "app.db"), process.env.SERVER_HOST);

const watcher = Bun.spawn(["bun", "scripts/dev/paraglide-dev.ts"], {
  cwd: process.cwd(),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const vite = Bun.spawn(["portless", "run", "--name", process.env.RACEIQ_DEV_PORTLESS_NAME ?? "raceiq", "bun", "run", "dev", "--host", "127.0.0.1"], {
  cwd: `${process.cwd()}/client`,
  env: { ...process.env, RACEIQ_DEV_HTTP_HOSTS: JSON.stringify(dashboardHosts) },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await vite.exited;
watcher.kill();
await watcher.exited;
process.exit(exitCode);
