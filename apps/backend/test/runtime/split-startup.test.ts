import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { createSocket } from "node:dgram";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ROOT_DIR } from "@raceiq/backend-core/runtime/config/paths";

test("startup splitting completes when the telemetry UDP port is occupied", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-split-startup-"));
  const blocker = createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    blocker.once("error", reject);
    blocker.bind(0, "0.0.0.0", resolve);
  });
  const udpPort = blocker.address().port;
  const reservation = Bun.serve({ port: 0, fetch: () => new Response() });
  const httpPort = reservation.port!;
  await reservation.stop(true);
  const env = {
    ...process.env, DATA_DIR: directory, NODE_ENV: "production", RACEIQ_TEST_MODE: "1",
    SERVER_PORT: String(httpPort), RACEIQ_DEV_UDP_PORT: String(udpPort),
    SERVER_HOST: "127.0.0.1", SERVER_ALLOWED_ORIGINS: "", SERVER_PASSWORD: "",
  };
  let server: Subprocess<"ignore", "pipe", "pipe"> | undefined;
  let logs: Promise<string> | undefined;
  let passed = false;
  try {
    const prepare = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/prepare-startup-split.ts", import.meta.url))], {
      cwd: ROOT_DIR, env, stdout: "pipe", stderr: "pipe",
    });
    const preparationOutput = Promise.all([new Response(prepare.stdout).text(), new Response(prepare.stderr).text()]);
    expect(await prepare.exited, (await preparationOutput).join("\n")).toBe(0);
    // Exercise startup directly; hot-reload watchers are unrelated to UDP recovery.
    server = Bun.spawn([process.execPath, "run", "apps/backend/src/index.ts"], {
      cwd: ROOT_DIR, env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
    });
    logs = Promise.all([new Response(server.stdout).text(), new Response(server.stderr).text()]).then((parts) => parts.join("\n"));
    const url = `http://127.0.0.1:${httpPort}/api/storage/split-migration`;
    type Status = { sessionCount: number; progress: { status: string; done: number; total: number; migrated: number; failed: number } };
    const deadline = Date.now() + 12_000;
    let initial: Status | undefined;
    // This subprocess regression exercises real event-loop timers; parent fake time cannot drive the server.
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { initial = await response.json() as Status; break; }
      } catch { /* Wait for the actual HTTP entry point to start. */ }
      await Bun.sleep(50);
    }
    expect(initial).toMatchObject({ sessionCount: 1, progress: { status: "idle", done: 0, total: 1 } });
    const start = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(start.status).toBe(202);
    let final = await start.json() as Status;
    while (Date.now() < deadline && final.progress.status === "running") {
      await Bun.sleep(100);
      final = await (await fetch(url, { signal: AbortSignal.timeout(1000) })).json() as Status;
    }
    expect(final.progress).toMatchObject({ status: "success", done: 1, total: 1, migrated: 1, failed: 0 });
    passed = true;
  } finally {
    if (server) {
      server.kill("SIGKILL");
      await server.exited;
      const output = await logs;
      if (!passed && output) console.error(output);
    }
    await new Promise<void>((resolve) => blocker.close(resolve));
    // Windows can retain file handles briefly after the subprocess has exited.
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 20_000);
