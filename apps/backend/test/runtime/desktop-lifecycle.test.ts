import { expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT_DIR } from "@raceiq/backend-core/runtime/config/paths";

type Ready = { type: "raceiq-ready"; protocolVersion: number; url: string; udpPort: number; udpListening: boolean };

function launch(directory: string, httpPort = 0) {
  const child = Bun.spawn([process.execPath, "apps/backend/src/bootstrap.ts"], {
    cwd: ROOT_DIR,
    env: {
      ...process.env, DATA_DIR: directory, NODE_ENV: "production", RACEIQ_DESKTOP: "1",
      SERVER_PORT: String(httpPort), SERVER_HOST: "127.0.0.1", SERVER_PASSWORD: "",
      SERVER_ALLOWED_ORIGINS: "", RACEIQ_E2E: "1", RACEIQ_DEV_UDP_PORT: "",
    },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  let output = "";
  let resolveReady!: (ready: Ready) => void;
  const ready = new Promise<Ready>((resolve) => { resolveReady = resolve; });
  const stdout = (async () => {
    let pending = "";
    for await (const chunk of child.stdout) {
      const text = Buffer.from(chunk).toString();
      output += text;
      pending += text;
      const lines = pending.split("\n");
      pending = lines.pop()!;
      for (const line of lines) {
        if (line.startsWith('{"type":"raceiq-ready"')) resolveReady(JSON.parse(line));
      }
    }
  })();
  const stderr = new Response(child.stderr).text().then((text) => { output += text; });
  return { child, ready, output: async () => { await Promise.all([stdout, stderr]); return output; } };
}

async function stop(child: ReturnType<typeof launch>["child"]) {
  if (child.exitCode !== null) return child.exitCode;
  child.kill("SIGTERM");
  const fallback = setTimeout(() => child.kill("SIGKILL"), 8000);
  try { return await child.exited; } finally { clearTimeout(fallback); }
}

test("desktop backend publishes its allocated loopback URL, persists settings and stops cleanly", async () => {
  const directory = await mkdtemp(join(tmpdir(), "raceiq-desktop lifecycle-"));
  const udp = createSocket("udp4");
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  const udpPort = udp.address().port;
  await new Promise<void>((resolve) => udp.close(resolve));
  await writeFile(join(directory, "settings.json"), JSON.stringify({ udpPort, onboardingComplete: true }));
  let running: ReturnType<typeof launch> | undefined;
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      running = launch(directory);
      const timeout = setTimeout(() => running?.child.kill("SIGKILL"), 12000);
      let ready: Ready;
      try {
        ready = await Promise.race([running.ready, running.child.exited.then(async () => { throw new Error(await running!.output()); })]);
      } finally { clearTimeout(timeout); }
      expect(ready).toMatchObject({ protocolVersion: 1, udpPort, udpListening: true });
      const url = new URL(ready.url);
      expect(url.hostname).toBe("127.0.0.1");
      expect(Number(url.port)).toBeGreaterThan(0);
      const status = await fetch(`${url}/api/auth/status`);
      expect(status.ok).toBe(true);
      if (attempt === 0) {
        expect((await fetch(`${url}/api/auth/setup`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ password: null, exposureConfirmed: true }),
        })).ok).toBe(true);
        expect((await fetch(`${url}/api/settings`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ driverName: "Desktop persistence" }),
        })).ok).toBe(true);
      } else {
        const settings = await (await fetch(`${url}/api/settings`)).json() as { driverName: string };
        expect(settings.driverName).toBe("Desktop persistence");
      }
      expect(await stop(running.child), await running.output()).toBe(0);
      const output = await running.output();
      expect(output).not.toContain("[Boot] Port cleared");
      expect(output).not.toContain("caffeinate started");
      expect(output).not.toContain("First run detected");
      running = undefined;
    }
  } finally {
    if (running) await stop(running.child);
    await rm(directory, { recursive: true, force: true });
  }
}, 40000);

test("desktop startup refuses a busy HTTP port without terminating its owner", async () => {
  const sentinel = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("sentinel alive") });
  const directory = await mkdtemp(join(tmpdir(), "raceiq-desktop-collision-"));
  const running = launch(directory, sentinel.port);
  const timeout = setTimeout(() => running.child.kill("SIGKILL"), 12000);
  try {
    expect(await running.child.exited).not.toBe(0);
    expect(await running.output()).toMatch(/Failed to start server.*port .* in use/);
    expect(await (await fetch(`http://127.0.0.1:${sentinel.port}`)).text()).toBe("sentinel alive");
  } finally {
    clearTimeout(timeout);
    await stop(running.child);
    sentinel.stop(true);
    await rm(directory, { recursive: true, force: true });
  }
}, 20000);
