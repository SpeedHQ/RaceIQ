import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { transferRoutes } from "../../src/routes/laps/transfer-routes";
import { temporaryDirectory, createLMUDuckDB, populateLMUDuckDB } from "@raceiq/game-lmu/test-support/duckdb";

describe("LMU DuckDB upload detection", () => {
test("rejects zero-lap recordings during detection", async () => {
    const path = join(temporaryDirectory(), "outlap.duckdb");
    await createLMUDuckDB(path, "(0,0)");
    const form = new FormData();
    form.append(
      "file",
      new File([readFileSync(path)], "outlap.duckdb"),
    );

    const response = await transferRoutes.request("/api/laps/detect-import", {
      method: "POST",
      body: form,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      format: "duckdb",
      supported: false,
      message: "Recording contains no complete laps to import.",
      preview: { completedLapCount: 0 },
    });
  });

test("rejects recordings without lap-distance telemetry during detection", async () => {
    const path = join(temporaryDirectory(), "missing-lap-distance.duckdb");
    await createLMUDuckDB(path, undefined, false);
    const form = new FormData();
    form.append(
      "file",
      new File([readFileSync(path)], "missing-lap-distance.duckdb"),
    );

    const response = await transferRoutes.request("/api/laps/detect-import", {
      method: "POST",
      body: form,
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      format: "duckdb",
      supported: false,
      message: "LMU telemetry recording contains no drivable samples",
    });
  });

test("accepts WAL-backed recordings when matching sidecar is uploaded", async () => {
    const path = join(temporaryDirectory(), "pending.duckdb");
    const bootstrap = await DuckDBInstance.create(path);
    bootstrap.closeSync();

    const instance = await DuckDBInstance.create(path);
    const connection = await instance.connect();
    try {
      await connection.run("PRAGMA disable_checkpoint_on_shutdown");
      await populateLMUDuckDB(connection);
    } finally {
      connection.closeSync();
      instance.closeSync();
    }

    const walPath = `${path}.wal`;
    expect(existsSync(walPath)).toBe(true);
    const databaseBytes = readFileSync(path);

    const missingWalForm = new FormData();
    missingWalForm.append(
      "file",
      new File([databaseBytes], "pending.duckdb"),
    );
    const missingWalResponse = await transferRoutes.request(
      "/api/laps/detect-import",
      { method: "POST", body: missingWalForm },
    );
    expect(await missingWalResponse.json()).toMatchObject({
      supported: false,
      message:
        'Recording requires its matching "pending.duckdb.wal" sidecar. Select both files together.',
    });

    const completeForm = new FormData();
    completeForm.append(
      "file",
      new File([databaseBytes], "pending.duckdb"),
    );
    completeForm.append(
      "wal",
      new File([readFileSync(walPath)], "pending.duckdb.wal"),
    );
    const completeResponse = await transferRoutes.request(
      "/api/laps/detect-import",
      { method: "POST", body: completeForm },
    );
    expect(await completeResponse.json()).toMatchObject({
      format: "duckdb",
      supported: true,
      preview: { completedLapCount: 2 },
    });
  });
});
