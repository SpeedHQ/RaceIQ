type ChildProcess = ReturnType<typeof startFixture>;
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fixture = join(import.meta.dir, "persisted-queue.fixture.ts");

function startFixture(dataDir: string, mode: string) {
  return Bun.spawn([process.execPath, fixture, mode], {
    env: { ...process.env, DATA_DIR: dataDir },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function readUntil(child: ChildProcess, marker: string): Promise<string> {
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let output = "";
  const deadline = Promise.withResolvers<never>();
  const timer = setTimeout(() => deadline.reject(new Error(`Fixture did not emit ${marker}`)), 20_000);
  try {
    while (!output.includes(marker)) {
      const next = await Promise.race([reader.read(), deadline.promise]);
      if (next.done) {
        const stderr = await new Response(child.stderr).text();
        throw new Error(`Fixture exited before ${marker}; status=${await child.exited}; stderr=${stderr}`);
      }
      output += decoder.decode(next.value, { stream: true });
    }
    return output;
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
}

async function withTempDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = mkdtempSync(join(tmpdir(), "raceiq-persisted-queue-"));
  try {
    await run(dataDir);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
}

describe("RaceIQ Online persisted upload coordinator", () => {
  test("child-process crash after durable acceptance redelivers idempotently", async () => {
    await withTempDataDir(async (dataDir) => {
      const prepare = startFixture(dataDir, "crash-prepare");
      await readUntil(prepare, "accepted-before-queue-ack");
      prepare.kill("SIGKILL");
      await prepare.exited;

      const recover = startFixture(dataDir, "crash-recover");
      await readUntil(recover, "crash-redelivery-verified");
      expect(await recover.exited).toBe(0);
      expect(prepare.killed).toBe(true);
    });
  });

  test("isolated coordinator covers retry, account switch, and graceful stop", async () => {
    await withTempDataDir(async (dataDir) => {
      const child = startFixture(dataDir, "integration-suite");
      await readUntil(child, "retry-account-shutdown-verified");
      expect(await child.exited).toBe(0);
    });
  });
});
