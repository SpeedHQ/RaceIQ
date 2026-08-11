import { describe, test, expect } from "bun:test";
import { bootstrap, newClient, runMigrations } from "../../support/db/migrations";

describe("migration regressions", () => {
  test("v45 keeps native car ordinals unique without treating names as identity", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 42);
    await client.execute(
      `INSERT INTO discovered_cars (game_id, ordinal, name)
       VALUES ('iracing', 101, 'Shared Display Name')`,
    );

    await runMigrations(client, 45);
    await client.execute(
      `INSERT INTO discovered_cars (game_id, ordinal, name)
       VALUES ('iracing', 202, 'Shared Display Name')`,
    );

    const rows = await client.execute(
      `SELECT ordinal, name
       FROM discovered_cars
       WHERE game_id = 'iracing'
       ORDER BY ordinal`,
    );
    expect(
      rows.rows.map((row) => ({
        ordinal: Number(row.ordinal),
        name: String(row.name),
      })),
    ).toEqual([
      { ordinal: 101, name: "Shared Display Name" },
      { ordinal: 202, name: "Shared Display Name" },
    ]);
    await expect(
      client.execute(
        `INSERT INTO discovered_cars (game_id, ordinal, name)
         VALUES ('iracing', 202, 'Different Name')`,
      ),
    ).rejects.toThrow();
    client.close();
  });

  test("v46 preserves valid layouts, rejects incomplete rows, and stales iRacing captures", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 45);
    await client.execute(
      `INSERT INTO sessions (
         id, car_ordinal, track_ordinal, game_id, raw_file, lap_detector_version
       )
       VALUES (1, 10, 20, 'iracing', 'capture.bin.gz', 'lapdetector_v1'),
              (2, 11, 21, 'f1-2025', 'f1-capture.bin.gz', 'lapdetector_v1')`,
    );
    await client.execute(
      `INSERT INTO laps (session_id, lap_number, lap_time, s1_time, s2_time, s3_time)
       VALUES (1, 1, 60, 30, 30, 0),
              (1, 2, 90, 30, 31, 29),
              (1, 3, 60, 30, NULL, NULL),
              (2, 1, 90, 30, 31, NULL),
              (2, 2, 90, 30, 31, 29)`,
    );

    await runMigrations(client);

    const rows = await client.execute("SELECT sector_times FROM laps ORDER BY session_id, lap_number");
    expect(rows.rows.map((row) => JSON.parse(String(row.sector_times)))).toEqual([[30, 30], [30, 31, 29], null, null, [30, 31, 29]]);
    const sessionVersions = await client.execute("SELECT id, lap_detector_version FROM sessions ORDER BY id");
    expect(
      sessionVersions.rows.map((row) => ({
        id: Number(row.id),
        version: row.lap_detector_version,
      })),
    ).toEqual([
      { id: 1, version: null },
      { id: 2, version: "lapdetector_v1" },
    ]);
    const columns = await client.execute("PRAGMA table_info(laps)");
    const names = columns.rows.map((row) => String(row.name));
    expect(names).toContain("sector_times");
    expect(names).not.toContain("s1_time");
    expect(names).not.toContain("s2_time");
    expect(names).not.toContain("s3_time");
    client.close();
  });

  test("v59 migrates persisted pit transitions to valid non-pace classes", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 50);
    await client.execute("INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 10, 20, 'iracing')");
    await client.execute("INSERT INTO laps (session_id, lap_number, lap_time, is_valid) VALUES (1, 7, 110, 1), (1, 8, 150, 1), (1, 9, 100, 1)");
    await client.execute("INSERT INTO session_results (id, session_id) VALUES (1, 1)");
    await client.execute("INSERT INTO pit_events (result_id, sequence, lap_number, linkage) VALUES (1, 1, 7, 'linked')");

    await runMigrations(client, 59);

    const rows = await client.execute("SELECT lap_number, is_valid, classification, invalid_reason FROM laps ORDER BY lap_number");
    expect(rows.rows.map((row) => ({ lapNumber: Number(row.lap_number), isValid: Number(row.is_valid), classification: row.classification, invalidReason: row.invalid_reason }))).toEqual([
      { lapNumber: 7, isValid: 1, classification: "in_lap", invalidReason: null },
      { lapNumber: 8, isValid: 1, classification: "out_lap", invalidReason: null },
      { lapNumber: 9, isValid: 1, classification: "pace", invalidReason: null },
    ]);
    client.close();
  });

  test("v60 maps every legacy lap class and drops scalar classification", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 59);
    await client.execute("INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 10, 20, 'iracing')");
    await client.execute(
      `INSERT INTO laps (session_id, lap_number, lap_time, classification)
       VALUES (1, 1, 100, 'pace'),
              (1, 2, 101, 'out_lap'),
              (1, 3, 102, 'in_lap'),
              (1, 4, 103, 'pit_lap'),
              (1, 5, 104, 'grid_start'),
              (1, 6, 105, 'caution')`,
    );

    await runMigrations(client);

    const rows = await client.execute("SELECT lap_number, phase, conditions, pace_eligibility FROM laps ORDER BY lap_number");
    expect(
      rows.rows.map((row) => ({
        lapNumber: Number(row.lap_number),
        phase: String(row.phase),
        conditions: JSON.parse(String(row.conditions)),
        paceEligibility: String(row.pace_eligibility),
      })),
    ).toEqual([
      { lapNumber: 1, phase: "flying", conditions: [], paceEligibility: "eligible" },
      { lapNumber: 2, phase: "out", conditions: [], paceEligibility: "excluded" },
      { lapNumber: 3, phase: "in", conditions: [], paceEligibility: "excluded" },
      { lapNumber: 4, phase: "pit", conditions: [], paceEligibility: "excluded" },
      { lapNumber: 5, phase: "grid_start", conditions: [], paceEligibility: "excluded" },
      { lapNumber: 6, phase: "flying", conditions: ["caution"], paceEligibility: "excluded" },
    ]);
    const columns = await client.execute("PRAGMA table_info(laps)");
    const columnNames = columns.rows.map((row) => String(row.name));
    expect(columnNames).toContain("phase");
    expect(columnNames).toContain("conditions");
    expect(columnNames).toContain("pace_eligibility");
    expect(columnNames).not.toContain("classification");
    client.close();
  });

  test("v61 seeds timing decisions without inventing channel fidelity for legacy laps", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 60);
    await client.execute("INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id, source) VALUES (1, 10, 20, 'iracing', 'motec')");
    await client.execute(
      `INSERT INTO laps (session_id, lap_number, lap_time, is_valid, phase, conditions, pace_eligibility)
       VALUES (1, 1, 100, 1, 'flying', '[]', 'eligible'),
              (1, 2, 75, 1, 'pit', '[]', 'excluded')`,
    );

    await runMigrations(client);

    const sessionRow = (await client.execute("SELECT recording_quality, quality_generation FROM sessions WHERE id = 1")).rows[0]!;
    const sessionQuality = JSON.parse(String(sessionRow.recording_quality));
    expect(sessionQuality.lifecycleState).toBe("unavailable");
    expect(sessionQuality.sourceKind).toBe("motec");
    expect(sessionQuality.facts.map(({ code }: { code: string }) => code)).toContain("quality_not_rebuilt");
    expect(sessionRow.quality_generation).toBe("legacy");

    const rows = await client.execute("SELECT lap_number, quality, eligibility, quality_generation FROM laps ORDER BY lap_number");
    const migrated = rows.rows.map((row) => ({
      lapNumber: Number(row.lap_number),
      quality: JSON.parse(String(row.quality)),
      eligibility: JSON.parse(String(row.eligibility)),
      generation: String(row.quality_generation),
    }));
    expect(migrated[0]?.quality.timing).toMatchObject({ source: "simulator-history", confirmed: true });
    expect(migrated[0]?.eligibility["official-timing"].status).toBe("eligible_with_warning");
    expect(migrated[0]?.eligibility["normal-pace"].status).toBe("eligible_with_warning");
    expect(migrated[0]?.eligibility["corner-trace"].status).toBe("unknown");
    expect(migrated[0]?.eligibility["corner-trace"].reasons[0].code).toBe("quality_not_rebuilt");
    expect(migrated[1]?.eligibility["normal-pace"].status).toBe("ineligible");
    expect(migrated[1]?.eligibility["normal-pace"].reasons[0].code).toBe("non_pace_classification");
    expect(migrated.every(({ generation }) => generation === "legacy")).toBe(true);
    client.close();
  });

  test("v62 adds nullable source channel profiles without inventing legacy fidelity", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 61);
    await client.execute("INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id, source) VALUES (1, 10, 20, 'ac-evo', 'motec')");

    await runMigrations(client);

    const row = (await client.execute("SELECT source_channel_profile FROM sessions WHERE id = 1")).rows[0]!;
    expect(row.source_channel_profile).toBeNull();
    const profile = JSON.stringify({
      schemaVersion: "1",
      sourceKind: "motec",
      channels: {
        "inputs.steer": {
          treatment: "assumed",
          mappingStatus: "simplified",
          sourceChannels: [{ name: "STEERANGLE", declaredHz: 60, effectiveHz: 60 }],
          limitations: ["Steering normalized using assumed 240 degree full lock."],
          evidenceId: "source-channel-profile:1:motec:inputs.steer",
        },
      },
    });
    await client.execute({ sql: "UPDATE sessions SET source_channel_profile = ? WHERE id = 1", args: [profile] });
    const persisted = (await client.execute("SELECT source_channel_profile FROM sessions WHERE id = 1")).rows[0]!;
    expect(JSON.parse(String(persisted.source_channel_profile))).toEqual(JSON.parse(profile));
    client.close();
  });
});
