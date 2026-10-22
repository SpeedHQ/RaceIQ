import { expect, test } from "@playwright/test";
import { execFile } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { StintsResponseSchema } from "@raceiq/shared/racing/live/strategy-schemas";
import { StrategyRuntime } from "./runtime";
import { ingestNativeRun } from "./native-source";

const lapState = "SELECT id,session_id,lap_number,lap_time,is_valid,notes,is_favorite,raw_byte_offset,raw_frame_count FROM laps WHERE session_id=? ORDER BY id";

test("A1-A3 startup backfills missing LMU stints from their recording without changing stored laps", async ({ browser, playwright }, testInfo) => {
  test.setTimeout(300_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-strategy-backfill-lmu"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const context = await browser.newContext();
  try {
    await runtime.waitForStrategyBackfill();
    const fixture = testInfo.outputPath("lmu-history.bin");
    await promisify(execFile)("bun", [resolve(runtime.root, "packages/race-strategy/test/e2e/convert-lmu-fixture.ts"),
      resolve(runtime.root, "test/artifacts/sessions/lmu-spa-iron-lynx-gte.bin.gz"), fixture]);
    const bytes = await readFile(fixture);
    const imported = await api.post("/api/laps/import", { multipart: {
      ownership: "mine", file: { name: "lmu-history.bin", mimeType: "application/octet-stream", buffer: bytes },
    }, timeout: 120_000 });
    expect(imported.ok(), await imported.text()).toBe(true);
    const result = await imported.json();
    expect(result.gameId).toBe("lmu");
    const sessionId = result.laps[0]?.sessionId;
    expect(Number.isSafeInteger(sessionId)).toBe(true);
    await runtime.crash();
    await runtime.databaseStatement("DELETE FROM strategy_stints WHERE session_id=?", [sessionId], true);
    await runtime.databaseStatement("DELETE FROM strategy_session_state WHERE session_id=?", [sessionId], true);
    await runtime.databaseStatement("UPDATE laps SET notes='keep lap note',is_favorite=1,lap_time=lap_time+0.125 WHERE session_id=?", [sessionId], true);
    await runtime.databaseStatement("UPDATE sessions SET notes='keep session note',is_favorite=1 WHERE id=?", [sessionId], true);
    const before = await runtime.databaseStatement(lapState, [sessionId]);
    await runtime.restart();
    const readStints = async () => {
      const response = await api.get(`/api/sessions/${sessionId}/stints`, { headers: { "X-Game-Id": "lmu" } });
      expect(response.ok(), await response.text()).toBe(true);
      return StintsResponseSchema.parse(await response.json()).stints;
    };
    await expect.poll(async () => (await readStints()).some(stint => stint.completedLaps > 0 && stint.fuel.eligibleLaps > 0), { timeout: 90_000 }).toBe(true);
    expect(await runtime.databaseStatement(lapState, [sessionId])).toEqual(before);
    expect(await runtime.databaseStatement("SELECT notes,is_favorite FROM sessions WHERE id=?", [sessionId])).toEqual([{ notes: "keep session note", is_favorite: 1 }]);
    const state = await runtime.databaseStatement("SELECT rebuild_generation FROM strategy_session_state WHERE session_id=?", [sessionId]);
    const summaries = await readStints();
    const page = await context.newPage();
    await page.goto(`${runtime.baseURL}/lmu/sessions/${sessionId}/analyse`);
    await expect(page.getByTestId("stint-summary-table")).toBeVisible();
    await expect(page.getByTestId("stint-summary-chart")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("automatically-backfilled-lmu-stints.png") });
    await runtime.crash();
    await runtime.restart();
    await expect.poll(async () => (await readStints()).map(stint => stint.id)).toEqual(summaries.map(stint => stint.id));
    expect(await readStints()).toEqual(summaries);
    expect(await runtime.databaseStatement("SELECT rebuild_generation FROM strategy_session_state WHERE session_id=?", [sessionId])).toEqual(state);
    expect(await runtime.databaseStatement(lapState, [sessionId])).toEqual(before);
    await runtime.crash();
    await runtime.databaseStatement("UPDATE strategy_stints SET payload=json_remove(json_set(payload,'$.algorithmVersion','stint-metrics-v1'),'$.rateStatistics') WHERE session_id=?", [sessionId], true);
    await runtime.restart();
    await runtime.waitForStrategyBackfill();
    expect((await readStints()).every((stint) => stint.rateStatistics != null)).toBe(true);
    expect((await readStints()).some((stint) => stint.fuel.eligibleLaps > 0)).toBe(true);
    expect(await runtime.databaseStatement(lapState, [sessionId])).toEqual(before);
    expect(await runtime.databaseStatement("SELECT rebuild_generation FROM strategy_session_state WHERE session_id=?", [sessionId])).not.toEqual(state);
  } finally {
    await context.close();
    await api.dispose();
    await runtime.stop();
  }
});

test("A1/A4 backfill skips active and missing recordings while repairing another recorded session", async ({ playwright }, testInfo) => {
  test.setTimeout(240_000);
  const runtime = await StrategyRuntime.start(testInfo.outputPath("test-data-strategy-backfill-isolation"));
  const api = await playwright.request.newContext({ baseURL: runtime.apiURL });
  const readStints = async (id: number) => {
    const response = await api.get(`/api/sessions/${id}/stints`, { headers: { "X-Game-Id": "fm-2023" } });
    expect(response.ok(), await response.text()).toBe(true);
    return StintsResponseSchema.parse(await response.json()).stints;
  };
  try {
    const lap = { fuelUsed: 0.02, wear: [0.008, 0.01, 0.006, 0.004] as [number, number, number, number] };
    const unavailable = { fuelUsed: 0, wear: [0, 0, 0, 0] as [number, number, number, number] };
    await ingestNativeRun({ carId: 639, initialFuel: -1, initialWear: [-1, -1, -1, -1], laps: [unavailable, unavailable, unavailable] }, runtime.udpPort);
    await ingestNativeRun({ carId: 642, timestampMs: 300_000, laps: [lap, lap, lap] }, runtime.udpPort);
    const sessions = await runtime.databaseStatement("SELECT id,car_id,raw_file FROM sessions ORDER BY id") as Array<{ id: number; car_id: string; raw_file: string }>;
    const measured = sessions.find(session => session.car_id === "642")!;
    const noMeasurements = sessions.find(session => session.car_id === "639")!;
    await expect.poll(async () => (await readStints(measured.id)).reduce((sum, stint) => sum + stint.completedLaps, 0)).toBe(3);
    await runtime.crash();
    for (const id of [measured.id, noMeasurements.id]) {
      await runtime.databaseStatement("DELETE FROM strategy_stints WHERE session_id=?", [id], true);
      await runtime.databaseStatement("DELETE FROM strategy_session_state WHERE session_id=?", [id], true);
    }
    await runtime.databaseStatement("INSERT INTO sessions(game_id,car_id,track_id,ownership,raw_file,lap_detector_version) VALUES('fm-2023','missing','missing','mine','/missing/recording.bin','missing')", [], true);
    const missing = (await runtime.databaseStatement("SELECT id FROM sessions WHERE car_id='missing'") as Array<{ id: number }>)[0]!.id;
    await runtime.databaseStatement("INSERT INTO laps(session_id,lap_number,lap_time,is_valid) VALUES(?,1,60,1)", [missing], true);
    await runtime.databaseStatement("INSERT INTO sessions(game_id,car_id,track_id,ownership,raw_file,lap_detector_version) VALUES('fm-2023','active','active','mine','/active/recording.bin','active')", [], true);
    const active = (await runtime.databaseStatement("SELECT id FROM sessions WHERE car_id='active'") as Array<{ id: number }>)[0]!.id;
    await runtime.databaseStatement("INSERT INTO laps(session_id,lap_number,lap_time,is_valid) VALUES(?,1,60,1)", [active], true);
    await runtime.databaseStatement("INSERT INTO live_captures(session_id,capture_epoch,attempt,source_path,archive_path,status) VALUES(?,'strategy-active','strategy-active','/active/recording.bin','/active/archive','recording')", [active], true);

    // Each candidate points at its own source copy; later valid work must survive earlier failures.
    const clone = async (name: string, carId = measured.car_id, offsetDelta = 0, corrupt = false) => {
      const rawFile = resolve(dirname(measured.raw_file), `${name}-${basename(measured.raw_file)}`);
      await copyFile(measured.raw_file, rawFile);
      if (corrupt) await writeFile(rawFile, "corrupt recording");
      await runtime.databaseStatement(`INSERT INTO sessions(game_id,car_id,track_id,ownership,source,raw_file,lap_detector_version,capture_format_version,capture_layout_version,capture_manifest_file,capture_archive_file)
        SELECT game_id,?,track_id,ownership,source,?,lap_detector_version,capture_format_version,capture_layout_version,CASE WHEN capture_manifest_file=raw_file THEN ? ELSE capture_manifest_file END,capture_archive_file FROM sessions WHERE id=?`,
      [carId, rawFile, rawFile, measured.id], true);
      const id = (await runtime.databaseStatement("SELECT id FROM sessions WHERE raw_file=?", [rawFile]) as Array<{ id: number }>)[0]!.id;
      await runtime.databaseStatement(`INSERT INTO laps(session_id,lap_number,lap_time,is_valid,notes,is_favorite,raw_byte_offset,raw_frame_count)
        SELECT ?,lap_number,lap_time,is_valid,notes,is_favorite,raw_byte_offset+?,raw_frame_count FROM laps WHERE session_id=?`, [id, offsetDelta, measured.id], true);
      return id;
    };
    const corrupt = await clone("corrupt", measured.car_id, 0, true);
    const identity = await clone("identity", "not-the-recorded-car");
    const window = await clone("window", measured.car_id, 1);
    const afterFailures = await clone("valid-after-failures");
    const unsafe = [missing, active, corrupt, identity, window];
    const lapSnapshots = new Map<number, unknown>();
    const sessionSnapshots = new Map<number, unknown>();
    const sessionState = "SELECT id,game_id,car_id,track_id,ownership,notes,is_favorite,raw_file,lap_detector_version,capture_format_version FROM sessions WHERE id=?";
    for (const id of unsafe) {
      lapSnapshots.set(id, await runtime.databaseStatement(lapState, [id]));
      sessionSnapshots.set(id, await runtime.databaseStatement(sessionState, [id]));
    }
    await runtime.restart();
    await runtime.waitForStrategyBackfill();
    for (const id of [measured.id, afterFailures]) {
      expect((await readStints(id)).some(stint => Math.abs((stint.fuel.value ?? 0) - 0.02) < 0.00001)).toBe(true);
    }
    for (const id of unsafe) {
      expect(await runtime.databaseStatement(lapState, [id])).toEqual(lapSnapshots.get(id));
      expect(await runtime.databaseStatement(sessionState, [id])).toEqual(sessionSnapshots.get(id));
      expect(await readStints(id)).toEqual([]);
      expect(await runtime.databaseStatement("SELECT rebuild_generation FROM strategy_session_state WHERE session_id=? AND rebuild_generation IS NOT NULL", [id])).toEqual([]);
    }
    const unsupported = await readStints(noMeasurements.id);
    expect(unsupported.reduce((sum, stint) => sum + stint.completedLaps, 0)).toBe(3);
    for (const stint of unsupported) {
      expect(stint.fuel.value).toBeNull();
      expect(stint.tires.map(rate => rate.value)).toEqual([null, null, null, null]);
    }
    const generation = await runtime.databaseStatement("SELECT rebuild_generation FROM strategy_session_state WHERE session_id=?", [noMeasurements.id]);
    expect(generation).toEqual([{ rebuild_generation: expect.any(String) }]);
    await runtime.restart();
    await runtime.waitForStrategyBackfill();
    expect(await readStints(noMeasurements.id)).toEqual(unsupported);
    expect(await runtime.databaseStatement("SELECT rebuild_generation FROM strategy_session_state WHERE session_id=?", [noMeasurements.id])).toEqual(generation);
  } finally {
    await api.dispose();
    await runtime.stop();
  }
});
