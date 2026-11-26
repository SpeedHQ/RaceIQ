import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChatGptMacAccounts } from "../../src/runtime/chatgpt-subscription-accounts";

test.skipIf(process.platform !== "darwin")("macOS account attempts share an installation lock and persist their host ID in Keychain", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "raceiq-mac-accounts-test-")));
  const first = createChatGptMacAccounts(dir);
  const second = createChatGptMacAccounts(dir);
  let pending: string | null = null;
  try {
    expect(await first.state()).toMatchObject({ availability: "available", accounts: [], attempt: null });
    const started = await first.connect(null);
    pending = started.attemptId;
    const firstUrl = new URL(started.authorizationUrl);
    const host = firstUrl.searchParams.get("ext_agent_host_id");
    expect(host).toMatch(/^urn:uuid:/);
    await expect(second.connect(null)).rejects.toMatchObject({ code: "attempt_in_progress" });
    await first.cancel("stale-id");
    expect((await first.state()).attempt?.status).toBe("pending");
    await first.cancel(started.attemptId);
    expect((await first.state()).attempt?.status).toBe("cancelled");
    const reopened = await second.connect(null);
    try {
      expect(new URL(reopened.authorizationUrl).searchParams.get("ext_agent_host_id")).toBe(host!);
      expect(reopened.attemptId).not.toBe(started.attemptId);
    } finally {
      await second.cancel(reopened.attemptId);
    }
  } finally {
    if (pending) await first.cancel(pending);
    const account = createHash("sha256").update(dir).digest("hex");
    Bun.spawnSync(["/usr/bin/security", "delete-generic-password", "-s", "RaceIQ.ChatGPTSubscription", "-a", account], {
      stdout: "ignore", stderr: "ignore", timeout: 5000,
    });
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);
