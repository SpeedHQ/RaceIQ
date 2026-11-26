import { afterEach, describe, expect, test } from "bun:test";
import { copyFile, link, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { IRacingCaptureManager, type IRacingCaptureOptions } from "../../src/runtime/iracing-capture";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function harness(overrides: IRacingCaptureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "raceiq-native-ibt-"));
  roots.push(root);
  const source = join(root, "source"), archive = join(root, "archive");
  await mkdir(source);
  let clock = 10000;
  const commands: boolean[] = [];
  const busy = new Set<string>();
  const manager = new IRacingCaptureManager({
    availability: () => null, resolveDirectory: () => source, archiveDirectory: archive,
    now: () => clock, pollIntervalMs: 0, settleMs: 100, shutdownFlushMs: 0,
    setLogging: (enabled) => { commands.push(enabled); }, isFileClosed: (path) => !busy.has(path),
    publishFile: async (stage, destination) => {
      try { await link(stage, destination); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
    },
    ...overrides,
  });
  return { manager, source, archive, commands, busy,
    advance: (ms = 101) => { clock += ms; },
    observe: (enabled: unknown, active: unknown) => manager.observe({ values: { IsDiskLoggingEnabled: enabled, IsDiskLoggingActive: active } }, clock),
    settle: async () => { await manager.tick(); clock += 101; await manager.tick(); },
  };
}

describe("automatic native iRacing capture", () => {
  test("requires opt-in and real SDK acknowledgement, preserves independently enabled logging", async () => {
    const h = await harness();
    h.observe(false, false);
    await h.manager.tick();
    expect(h.manager.status().state).toBe("disconnected");
    expect(h.commands).toEqual([]);
    await h.manager.connect(true);
    expect(h.manager.status().state).toBe("waiting-for-recording");
    h.observe(false, false);
    await h.manager.tick();
    expect(h.commands).toEqual([true]);
    h.observe(true, false);
    expect(h.manager.status().state).toBe("waiting-for-recording");
    h.observe(true, true);
    expect(h.manager.status().state).toBe("recording");
    await h.manager.connect(false);
    expect(h.commands).toEqual([true, false]);
    expect(h.manager.status().state).toBe("disconnected");

    const user = await harness();
    user.observe(true, true);
    await user.manager.connect(true);
    expect(user.manager.status().state).toBe("recording");
    await user.manager.connect(false);
    expect(user.commands).toEqual([]);
  });

  test("missing SDK flags never imply enabled or active logging; stale observations require reconnect evidence", async () => {
    const h = await harness();
    await h.manager.connect(true);
    expect(h.manager.status().state).toBe("waiting-for-iracing");
    h.observe(undefined, Number.NaN);
    await h.manager.tick();
    expect(h.manager.status().state).toBe("waiting-for-recording");
    expect(h.commands).toEqual([]);
    h.observe(false, false);
    await h.manager.tick();
    h.observe(true, true);
    h.advance(6000);
    await h.manager.tick();
    expect(h.manager.status().state).toBe("waiting-for-iracing");
    h.observe(false, false);
    await h.manager.tick();
    expect(h.commands).toEqual([true, true]);
    h.observe(true, true);
    expect(h.manager.status().state).toBe("recording");
    await h.manager.stop();
  });

  test("unacknowledged native command becomes error instead of fabricated recording", async () => {
    const h = await harness();
    h.observe(false, false);
    await h.manager.connect(true);
    h.advance(10001);
    h.observe(false, false);
    await h.manager.tick();
    // A genuinely disconnected source can reconnect, so maintain fresh observations
    // while waiting for the acknowledgement of the new request.
    h.advance(3000); h.observe(false, false); await h.manager.tick();
    h.advance(3000); h.observe(false, false); await h.manager.tick();
    h.advance(3000); h.observe(false, false); await h.manager.tick();
    h.advance(1100); h.observe(false, false); await h.manager.tick();
    expect(h.manager.status().state).toBe("error");
    expect(h.manager.status().reason).toBe("sdk-command-failed");
    expect(h.commands).toEqual([true, true]);
    await h.manager.stop();
  });

  test("archives only changed in-window files after the paused writer closes, preserving exact bytes and originals", async () => {
    const h = await harness();
    await writeFile(join(h.source, "historical.ibt"), "old recording");
    await h.manager.connect(true);
    const path = join(h.source, "new.ibt"), bytes = Buffer.from([0, 255, 1, 7, 42, 0, 9]);
    await writeFile(path, bytes);
    h.busy.add(path);
    await h.settle();
    expect(await readdir(h.archive)).toEqual([]);
    h.busy.delete(path);
    await h.manager.tick();
    const archived = h.manager.status().lastSavedFile!;
    expect(await readFile(archived)).toEqual(bytes);
    expect(await readFile(path)).toEqual(bytes);
    expect(await readFile(join(h.source, "historical.ibt"), "utf8")).toBe("old recording");
    expect(h.manager.status().savedFiles).toBe(1);
    await h.manager.stop();
  });

  test("collects a final pending file after disconnect but not new independent recordings", async () => {
    const h = await harness();
    await h.manager.connect(true);
    const last = join(h.source, "last.ibt");
    h.busy.add(last);
    await writeFile(last, "unfinished");
    await h.manager.connect(false);
    expect(h.manager.status().state).toBe("saving");
    await writeFile(last, "completed final recording");
    await writeFile(join(h.source, "after-disconnect.ibt"), "unrelated future recording");
    h.busy.delete(last);
    await h.settle();
    expect(h.manager.status().state).toBe("disconnected");
    expect(await readFile(h.manager.status().lastSavedFile!, "utf8")).toBe("completed final recording");
    expect((await readdir(h.archive)).filter((name) => name.endsWith(".ibt"))).toHaveLength(1);
    expect(await readFile(join(h.source, "after-disconnect.ibt"), "utf8")).toBe("unrelated future recording");
  });

  test("retains filename generations without overwrite and deduplicates identical bytes", async () => {
    const h = await harness();
    await h.manager.connect(true);
    const path = join(h.source, "reused.ibt");
    await writeFile(path, "first generation");
    await h.settle();
    const first = h.manager.status().lastSavedFile!;
    await writeFile(path, "second generation with different bytes");
    await h.settle();
    const second = h.manager.status().lastSavedFile!;
    expect(await readFile(first, "utf8")).toBe("first generation");
    expect(await readFile(second, "utf8")).toBe("second generation with different bytes");
    await writeFile(path, "first generation");
    await h.settle();
    expect(h.manager.status().savedFiles).toBe(2);
    expect((await readdir(h.archive)).filter((name) => name.endsWith(".ibt"))).toHaveLength(2);
    expect(await readFile(path, "utf8")).toBe("first generation");
    await h.manager.stop();
  });

  test("failed or changing copies publish no partial archive and leave source untouched", async () => {
    const h = await harness({ copyFile: async (_source, stage) => { await writeFile(stage, "partial"); throw new Error("Disk full"); } });
    await h.manager.connect(true);
    const path = join(h.source, "failure.ibt");
    await writeFile(path, "complete original");
    await h.settle();
    expect(h.manager.status().reason).toBe("archive-failed");
    expect(await readdir(h.archive)).toEqual([]);
    expect(await readFile(path, "utf8")).toBe("complete original");

    const changing = await harness({ copyFile: async (source, stage) => { await copyFile(source, stage); await writeFile(source, "new longer source after copy"); } });
    await changing.manager.connect(true);
    const live = join(changing.source, "changed.ibt");
    await writeFile(live, "old bytes");
    await changing.settle();
    expect(changing.manager.status().reason).toBe("archive-failed");
    expect(await readdir(changing.archive)).toEqual([]);
    expect(await readFile(live, "utf8")).toBe("new longer source after copy");
  });

  test("unsupported or disabled native capture stays unavailable without opt-in", async () => {
    for (const reason of ["unsupported-platform", "feature-disabled"] as const) {
      const h = await harness({ availability: () => reason });
      await h.manager.connect(true);
      expect(h.manager.status()).toMatchObject({ state: "unavailable", connected: false, supported: false, reason });
      expect(h.commands).toEqual([]);
    }
  });
});
