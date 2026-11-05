import { expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { CodexSupervisor } from "../../../src/ai/codex/supervisor";

test("shutdown terminates an owned CLI preflight and refuses later generation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-codex-owner-test-"));
  const marker = join(directory, "owned-pid");
  const owner = new CodexSupervisor();
  const input = { command: [process.execPath, fileURLToPath(new URL("./fixtures/codex-runtime-peer.ts", import.meta.url)), "stall-version", marker], model: "gpt-6.1-sol", prompt: "fixture" };
  const pending = owner.run(input).catch((error: unknown) => error);
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    if (!existsSync(marker)) throw new Error("Owned CLI never became ready");
    const pid = Number(readFileSync(marker, "utf8"));
    await owner.stop();
    expect(await pending).toMatchObject({ code: "cancelled" });
    let exitCode: unknown;
    try {
      process.kill(pid, 0);
    } catch (error) {
      exitCode = (error as NodeJS.ErrnoException).code;
    }
    expect(exitCode).toBe("ESRCH");
    await expect(owner.run(input)).rejects.toMatchObject({ code: "cancelled" });
  } finally {
    await owner.stop();
    await pending;
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);

test("backend shutdown reaps its active app-server before exiting", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-codex-shutdown-test-"));
  const marker = join(directory, "owned-pid");
  const child = Bun.spawn([process.execPath, fileURLToPath(new URL("./fixtures/codex-shutdown-backend.ts", import.meta.url)), directory], {
    env: { ...process.env, DATA_DIR: directory },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
    ipc() {},
  });
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = Date.now() + 5000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    if (!existsSync(marker)) throw new Error("Backend never reached the owned generation");
    const pid = Number(readFileSync(marker, "utf8"));
    child.send({ type: "shutdown" });
    const code = await Promise.race([
      child.exited,
      new Promise((resolve) => {
        deadlineTimer = setTimeout(() => resolve("deadline"), 8000);
      }),
    ]);
    expect(code).toBe(0);
    let exitCode: unknown;
    try {
      process.kill(pid, 0);
    } catch (error) {
      exitCode = (error as NodeJS.ErrnoException).code;
    }
    expect(exitCode).toBe("ESRCH");
  } finally {
    clearTimeout(deadlineTimer);
    writeFileSync(`${marker}.stop`, "stop");
    child.kill();
    await child.exited;
    // Give the test-only rescue signal time to stop a peer on a failing implementation.
    await new Promise((resolve) => setTimeout(resolve, 50));
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);

test("a completed response racing shutdown is not published after child cleanup", async () => {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-codex-completion-test-"));
  const marker = join(directory, "owned-pid");
  const owner = new CodexSupervisor();
  const pending = owner
    .run({ command: [process.execPath, fileURLToPath(new URL("./fixtures/codex-runtime-peer.ts", import.meta.url)), "completed-awaiting-close", marker], model: "gpt-6.1-sol", prompt: "fixture" })
    .catch((error: unknown) => error);
  try {
    const deadline = Date.now() + 3000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    if (!existsSync(marker)) throw new Error("CLI never reached completed-response cleanup");
    const stopped = owner.stop();
    expect(owner.stop()).toBe(stopped);
    await stopped;
    expect(await pending).toMatchObject({ code: "cancelled" });
  } finally {
    writeFileSync(`${marker}.stop`, "stop");
    await owner.stop();
    await pending;
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);
