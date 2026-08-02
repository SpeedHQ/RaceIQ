import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";

import { loadSettings } from "../server/runtime/config/settings";
import { db, client } from "../server/db";
import { driverProfileRuns } from "../server/db/schema";
import { createDriverProfileRun, updateDriverProfileRun, getDriverProfileRun, listDriverProfileRuns, findDriverProfileRunByScopePool } from "../server/db/driver-profile-queries";

const SETTINGS_PATH = `${process.env.DATA_DIR ?? "./data"}/settings.json`;
const scope = { gameId: "fm-2023" as const, carOrdinal: 42, trackOrdinal: 7 };

let originalSettings: string | null = null;

describe("driver profile run persistence", () => {
  beforeEach(async () => {
    if (existsSync(SETTINGS_PATH)) originalSettings = readFileSync(SETTINGS_PATH, "utf-8");
    await db.delete(driverProfileRuns).run();
  });

  afterEach(() => {
    if (originalSettings !== null) writeFileSync(SETTINGS_PATH, originalSettings);
    originalSettings = null;
  });

  test("settings default background profiling off with independent empty model controls", () => {
    writeFileSync(SETTINGS_PATH, "{}\n");
    const settings = loadSettings();
    expect(settings.driverProfileBackgroundEnabled).toBe(false);
    expect(settings.driverProfileProvider).toBe("");
    expect(settings.driverProfileModel).toBe("");
    expect(settings.driverProfileThinkingBudget).toBeNull();
    expect(settings.localEndpoint).toBe("http://localhost:1234/v1");
  });

  test("migration exposes the run table", async () => {
    const result = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'driver_profile_runs'",
    );
    expect(result.rows).toHaveLength(1);
  });

  test("creates and updates a run through its lifecycle", async () => {
    const id = await createDriverProfileRun(scope, { poolKey: "pool-a", model: "model-a" });
    expect(id).toBeGreaterThan(0);

    expect(await getDriverProfileRun(id)).toMatchObject({
      id,
      scopeKey: "fm-2023|42|7",
      status: "queued",
      poolKey: "pool-a",
      model: "model-a",
      fingerprint: null,
      plan: null,
    });

    await expect(
      updateDriverProfileRun(id, "fm-2023|other|scope", "queued", { status: "running" }),
    ).rejects.toThrow("was not owned");
    await expect(
      updateDriverProfileRun(id, "fm-2023|42|7", "queued", { status: "succeeded" }),
    ).rejects.toThrow("Invalid driver profile run transition");

    await updateDriverProfileRun(id, "fm-2023|42|7", "queued", {
      status: "running",
      startedAt: "2026-07-29T12:00:00.000Z",
    });
    await updateDriverProfileRun(id, "fm-2023|42|7", "running", {
      status: "succeeded",
      fingerprint: '{"pace":1}',
      plan: '{"summary":"keep braking"}',
      inputTokens: 11,
      outputTokens: 13,
      costUsd: 0.42,
      durationMs: 900,
      completedAt: "2026-07-29T12:00:01.000Z",
    });

    expect(await getDriverProfileRun(id)).toMatchObject({
      status: "succeeded",
      startedAt: "2026-07-29T12:00:00.000Z",
      completedAt: "2026-07-29T12:00:01.000Z",
      fingerprint: '{"pace":1}',
      plan: '{"summary":"keep braking"}',
      inputTokens: 11,
      outputTokens: 13,
      costUsd: 0.42,
      durationMs: 900,
    });
  });

  test("finds runs by canonical scope and pool", async () => {
    const id = await createDriverProfileRun(scope, { poolKey: "pool-b", status: "failed", error: "offline" });
    const found = await findDriverProfileRunByScopePool(scope, "pool-b");
    expect(found?.id).toBe(id);
    expect(found?.status).toBe("failed");
    expect(found?.error).toBe("offline");
    expect(await findDriverProfileRunByScopePool(scope, "missing")).toBeNull();
  });

  test("lists history newest first within a scope", async () => {
    const oldest = await createDriverProfileRun(scope, { poolKey: "oldest", createdAt: "2026-07-29 12:00:00" });
    const newest = await createDriverProfileRun(scope, { poolKey: "newest", createdAt: "2026-07-29T12:01:00.000Z" });
    await createDriverProfileRun({ gameId: "fm-2023", carOrdinal: 99, trackOrdinal: 7 }, { poolKey: "other-scope" });

    const history = await listDriverProfileRuns(scope);
    expect(history.map((run) => run.id)).toEqual([newest, oldest]);
    expect(history.map((run) => run.poolKey)).toEqual(["newest", "oldest"]);
  });
});
