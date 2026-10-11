import { describe, test, expect } from "bun:test";
import {
  bootstrap,
  newClient,
  runMigrations,
} from "@raceiq/backend-core/test-support/db/migrations";

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

  test("v46 preserves valid sector layouts and rejects incomplete rows", async () => {
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

    const rows = await client.execute(
      "SELECT sector_times FROM laps ORDER BY session_id, lap_number",
    );
    expect(rows.rows.map((row) => JSON.parse(String(row.sector_times)))).toEqual([
      [30, 30],
      [30, 31, 29],
      null,
      null,
      [30, 31, 29],
    ]);
    const columns = await client.execute("PRAGMA table_info(laps)");
    const names = columns.rows.map((row) => String(row.name));
    expect(names).toContain("sector_times");
    expect(names).not.toContain("s1_time");
    expect(names).not.toContain("s2_time");
    expect(names).not.toContain("s3_time");
    client.close();
  });

  test("v51 excludes persisted pit entry and exit laps from pace metrics", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 50);
    await client.execute("INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 10, 20, 'iracing')");
    await client.execute("INSERT INTO laps (session_id, lap_number, lap_time, is_valid) VALUES (1, 7, 110, 1), (1, 8, 150, 1), (1, 9, 100, 1)");
    await client.execute("INSERT INTO session_results (id, session_id) VALUES (1, 1)");
    await client.execute("INSERT INTO pit_events (result_id, sequence, lap_number, linkage) VALUES (1, 1, 7, 'linked')");

    await runMigrations(client);

    const rows = await client.execute("SELECT lap_number, is_valid, invalid_reason FROM laps ORDER BY lap_number");
    expect(rows.rows.map((row) => ({ lapNumber: Number(row.lap_number), isValid: Number(row.is_valid), invalidReason: row.invalid_reason }))).toEqual([
      { lapNumber: 7, isValid: 0, invalidReason: "inlap" },
      { lapNumber: 8, isValid: 0, invalidReason: "outlap" },
      { lapNumber: 9, isValid: 1, invalidReason: null },
    ]);
    client.close();
  });

  test("v58 normalizes pre-existing null and invalid ownership values", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 57);
    await client.execute("ALTER TABLE sessions ADD COLUMN ownership TEXT");
    await client.execute(
      "INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id, ownership) VALUES (1, 10, 20, 'iracing', NULL), (2, 10, 20, 'iracing', 'legacy')",
    );
    await runMigrations(client);

    const rows = await client.execute("SELECT id, ownership FROM sessions ORDER BY id");
    expect(rows.rows.map((row) => ({ id: Number(row.id), ownership: row.ownership }))).toEqual([
      { id: 1, ownership: "mine" },
      { id: 2, ownership: "mine" },
    ]);
    client.close();
  });

  test("v58 backfills old sessions", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 57);
    await client.execute(
      "INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 10, 20, 'iracing')",
    );
    await runMigrations(client);

    const rows = await client.execute("SELECT ownership FROM sessions WHERE id = 1");
    expect(rows.rows[0]?.ownership).toBe("mine");
    client.close();
  });
  test("v58 defaults ownership to mine when omitted", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client);
    await client.execute(
      "INSERT INTO sessions (id, car_id, track_id, game_id) VALUES (1, '10', '20', 'iracing')",
    );

    const rows = await client.execute("SELECT ownership FROM sessions WHERE id = 1");
    expect(rows.rows[0]?.ownership).toBe("mine");
    client.close();
  });

  test("final identity migration converts legacy numeric session IDs to strings", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 58);
    await client.execute(
      "INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 12345, 67890, 'lmu')"
    );

    await runMigrations(client);

    const rows = await client.execute(
      `SELECT car_id, track_id FROM sessions WHERE id = 1`,
    );
    expect(rows.rows[0]).toMatchObject({
      car_id: "12345",
      track_id: "67890",
    });
    client.close();
  });
  test("v60 marks existing static lap analysis stale without dropping cached data", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 59);
    await client.execute(
      "INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 10, 20, 'iracing')",
    );
    await client.execute(
      "INSERT INTO laps (id, session_id, lap_number, lap_time) VALUES (1, 1, 1, 90)",
    );
    await client.execute(
      "INSERT INTO lap_metrics (lap_id, algo_version, insights, segment_stats) VALUES (1, 3, '[{\"id\":\"legacy\"}]', '[]')",
    );

    await runMigrations(client);

    const rows = await client.execute(
      "SELECT insight_version, insights FROM lap_metrics WHERE lap_id = 1",
    );
    expect(rows.rows[0]).toMatchObject({
      insight_version: 0,
      insights: '[{"id":"legacy"}]',
    });
    client.close();
  });
  test("migrates historical AC Evo identities and preserves linked data", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 63);
    await client.execute(
      `INSERT INTO discovered_cars (game_id, ordinal, name, model, source_key)
       VALUES ('ac-evo', 51001, 'RaceIQ Migration Historical Car', 'raceiq_car', 'legacy car key')`,
    );
    await client.execute(
      `INSERT INTO discovered_cars (game_id, ordinal, name, model, source_key)
       VALUES ('ac-evo', 51002, 'RaceIQ Migration Historical Car', 'raceiq_car', 'legacy duplicate car key')`,
    );
    await client.execute(
      `INSERT INTO discovered_tracks (game_id, ordinal, name, source_key, track_name, track_configuration)
       VALUES ('ac-evo', 41001, 'RaceIQ Migration Historical Circuit', '["raceiq migration historical circuit","historical layout"]', 'RaceIQ Migration Historical Circuit', 'Historical Layout')`,
    );
    await client.execute(
      `INSERT INTO discovered_tracks (game_id, ordinal, name, source_key, track_name, track_configuration)
       VALUES ('ac-evo', 41002, 'RaceIQ Migration Historical Circuit', 'legacy duplicate track key', 'RaceIQ Migration Historical Circuit', 'Historical Layout')`,
    );
    await client.execute(
      `INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id, notes, is_favorite)
       VALUES (1, 51001, 41001, 'ac-evo', 'keep session note', 1)`,
    );
    await client.execute(
      `INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id, notes)
       VALUES (2, 51002, 41002, 'ac-evo', 'duplicate identity session')`,
    );
    await client.execute(
      `INSERT INTO laps (id, session_id, lap_number, lap_time, is_valid, notes)
       VALUES (2, 2, 1, 121000, 1, 'duplicate identity lap')`,
    );
    await client.execute(
      `INSERT INTO laps (id, session_id, lap_number, lap_time, is_valid, notes)
       VALUES (1, 1, 1, 120000, 1, 'keep lap note')`,
    );
    await client.execute(
      `INSERT INTO tunes (id, game_id, name, author, car_ordinal, track_ordinal, category, settings)
       VALUES (1, 'ac-evo', 'Historical tune', 'test', 51001, 41001, 'circuit', '{}')`,
    );
    await client.execute(
      `INSERT INTO tune_assignments (id, game_id, car_ordinal, track_ordinal, tune_id)
       VALUES (1, 'ac-evo', 51001, 41001, 1), (2, 'ac-evo', 51002, 41002, 1)`,
    );
    await client.execute(
      `INSERT INTO track_outlines (id, track_ordinal, game_id, outline)
       VALUES (1, 41001, 'ac-evo', X'010203'), (2, 41002, 'ac-evo', X'040506')`,
    );
    await client.execute(
      `INSERT INTO track_corners (id, track_ordinal, game_id, corner_index, label, distance_start, distance_end)
       VALUES (1, 41001, 'ac-evo', 0, 'Old Turn 1', 0, 100),
              (2, 41002, 'ac-evo', 0, 'Turn 1', 0, 120)`,
    );
    await client.execute(
      `INSERT INTO community_tunes (id,game_id,car_ordinal,track_ordinal,name,author,category,settings)
       VALUES ('native-migration', 'ac-evo', 51001, 41001, 'Community setup', 'test', 'circuit', '{"wing":3}')`,
    );
    await client.execute(
      `INSERT INTO driver_profiles (id,scope_key,game_id,car_ordinal,track_ordinal,pool_key,fingerprint,plan)
       VALUES (1,'ac-evo|51001|41001','ac-evo',51001,41001,'old-pool','{}','{"goal":"old"}'),
              (2,'ac-evo|51002|41002','ac-evo',51002,41002,'latest-pool','{}','{"goal":"latest"}')`,
    );
    await client.execute(
      `INSERT INTO driver_profile_runs (id,scope_key,game_id,car_ordinal,track_ordinal,pool_key,status)
       VALUES (1,'ac-evo|51001|41001','ac-evo',51001,41001,'old-pool','succeeded'),
              (2,'ac-evo|*|*','ac-evo',NULL,NULL,'global-pool','queued')`,
    );

    await runMigrations(client);

    const session = await client.execute("SELECT car_id,track_id,notes,is_favorite FROM sessions WHERE id=1");
    expect(session.rows[0]).toMatchObject({
      car_id: "RaceIQ Migration Historical Car",
      track_id: '["RaceIQ Migration Historical Circuit","Historical Layout"]', notes: "keep session note", is_favorite: 1,
    });
    const duplicateSession = await client.execute("SELECT car_id,track_id,notes FROM sessions WHERE id=2");
    expect(duplicateSession.rows[0]).toMatchObject({
      car_id: "RaceIQ Migration Historical Car",
      track_id: '["RaceIQ Migration Historical Circuit","Historical Layout"]', notes: "duplicate identity session",
    });
    const lap = await client.execute("SELECT session_id,lap_number,notes FROM laps WHERE id=1");
    expect(lap.rows[0]).toMatchObject({ session_id: 1, lap_number: 1, notes: "keep lap note" });
    const duplicateLap = await client.execute("SELECT session_id,notes FROM laps WHERE id=2");
    expect(duplicateLap.rows[0]).toMatchObject({ session_id: 2, notes: "duplicate identity lap" });
    const tune = await client.execute("SELECT car_id,track_id FROM tunes WHERE id=1");
    expect(tune.rows[0]).toMatchObject({
      car_id: "RaceIQ Migration Historical Car", track_id: '["RaceIQ Migration Historical Circuit","Historical Layout"]',
    });
    const assignment = await client.execute("SELECT id,car_id,track_id,tune_id FROM tune_assignments");
    expect(assignment.rows).toHaveLength(1);
    expect(assignment.rows[0]).toMatchObject({
      id: 2, car_id: "RaceIQ Migration Historical Car",
      track_id: '["RaceIQ Migration Historical Circuit","Historical Layout"]', tune_id: 1,
    });
    const outline = await client.execute("SELECT id,track_id,outline FROM track_outlines WHERE game_id='ac-evo'");
    expect(outline.rows).toHaveLength(1);
    expect(outline.rows[0]).toMatchObject({ id: 2, track_id: '["RaceIQ Migration Historical Circuit","Historical Layout"]' });
    const outlineBytes = outline.rows[0].outline as ArrayBuffer | Uint8Array;
    expect(Array.from(outlineBytes instanceof ArrayBuffer ? new Uint8Array(outlineBytes) : outlineBytes)).toEqual([4, 5, 6]);
    const corner = await client.execute("SELECT id,track_id,corner_index,label FROM track_corners WHERE game_id='ac-evo'");
    expect(corner.rows).toHaveLength(1);
    expect(corner.rows[0]).toMatchObject({
      id: 2, track_id: '["RaceIQ Migration Historical Circuit","Historical Layout"]', corner_index: 0, label: "Turn 1",
    });
    const cars = await client.execute("SELECT car_id,name,model FROM discovered_cars WHERE game_id='ac-evo' AND car_id='RaceIQ Migration Historical Car'");
    expect(cars.rows).toHaveLength(1);
    expect(cars.rows[0]).toMatchObject({
      car_id: "RaceIQ Migration Historical Car", name: "RaceIQ Migration Historical Car", model: "raceiq_car",
    });
    const tracks = await client.execute("SELECT track_id,track_name,track_configuration FROM discovered_tracks WHERE game_id='ac-evo' AND track_id='[\"RaceIQ Migration Historical Circuit\",\"Historical Layout\"]'");
    expect(tracks.rows).toHaveLength(1);
    expect(tracks.rows[0]).toMatchObject({
      track_id: '["RaceIQ Migration Historical Circuit","Historical Layout"]',
      track_name: "RaceIQ Migration Historical Circuit", track_configuration: "Historical Layout",
    });
    const nativeScope = JSON.stringify([
      "ac-evo", "RaceIQ Migration Historical Car",
      '["RaceIQ Migration Historical Circuit","Historical Layout"]',
    ]);
    const cachedProfile = await client.execute("SELECT id,scope_key,pool_key,plan FROM driver_profiles");
    expect(cachedProfile.rows).toHaveLength(1);
    expect(cachedProfile.rows[0]).toMatchObject({
      id: 2, scope_key: nativeScope, pool_key: "latest-pool", plan: '{"goal":"latest"}',
    });
    const runs = await client.execute("SELECT id,scope_key,car_id,track_id,status FROM driver_profile_runs ORDER BY id");
    expect(runs.rows).toHaveLength(2);
    expect(runs.rows).toMatchObject([
      {
        id: 1, scope_key: nativeScope, car_id: "RaceIQ Migration Historical Car",
        track_id: '["RaceIQ Migration Historical Circuit","Historical Layout"]', status: "succeeded",
      },
      { id: 2, scope_key: '["ac-evo",null,null]', car_id: null, track_id: null, status: "queued" },
    ]);
    const community = await client.execute("SELECT car_id,track_id,settings FROM community_tunes WHERE id='native-migration'");
    expect(community.rows).toHaveLength(1);
    expect(community.rows[0]).toMatchObject({
      car_id: "RaceIQ Migration Historical Car",
      track_id: '["RaceIQ Migration Historical Circuit","Historical Layout"]', settings: '{"wing":3}',
    });
    const legacyIdentityColumns = [
      ["sessions", "car_ordinal"], ["sessions", "track_ordinal"],
      ["tunes", "car_ordinal"], ["tunes", "track_ordinal"],
      ["tune_assignments", "car_ordinal"], ["tune_assignments", "track_ordinal"],
      ["track_outlines", "track_ordinal"], ["track_corners", "track_ordinal"],
      ["discovered_cars", "ordinal"], ["discovered_tracks", "ordinal"],
      ["community_tunes", "car_ordinal"], ["community_tunes", "track_ordinal"],
      ["driver_profiles", "car_ordinal"], ["driver_profiles", "track_ordinal"],
      ["driver_profile_runs", "car_ordinal"], ["driver_profile_runs", "track_ordinal"],
    ] as const;
    for (const [table, legacyColumn] of legacyIdentityColumns) {
      const columns = await client.execute(`PRAGMA table_info(${table})`);
      expect(columns.rows.map((row) => row.name)).not.toContain(legacyColumn);
    }
    client.close();
  });



  test("v67 queues every historical session once without changing saved data", async () => {
    const client = newClient();
    try {
      await bootstrap(client);
      await runMigrations(client, 66);
      await client.execute(`INSERT INTO sessions
        (id,game_id,car_id,track_id,lap_detector_version,raw_file,notes,is_favorite) VALUES
        (1,'ac-evo','Already native','["Monza","GP"]','current-evo','old-evo.bin','keep session',1),
        (2,'acc','34','2','current-acc','old-acc.bin',NULL,0),
        (3,'fm-2023','3631','5','current-forza',NULL,'missing capture',0)`);
      await client.execute(`INSERT INTO laps
        (id,session_id,lap_number,lap_time,notes,is_favorite)
        VALUES (1,1,8,93.5,'keep lap',1)`);

      await runMigrations(client);
      const queued = await client.execute("SELECT id,lap_detector_version FROM sessions ORDER BY id");
      expect(queued.rows).toHaveLength(3);
      expect(queued.rows).toMatchObject([
        { id: 1, lap_detector_version: null },
        { id: 2, lap_detector_version: null },
        { id: 3, lap_detector_version: null },
      ]);
      const session = await client.execute("SELECT car_id,track_id,notes,is_favorite FROM sessions WHERE id=1");
      expect(session.rows[0]).toMatchObject({
        car_id: "Already native", track_id: '["Monza","GP"]', notes: "keep session", is_favorite: 1,
      });
      const lap = await client.execute("SELECT id,session_id,lap_number,lap_time,notes,is_favorite FROM laps");
      expect(lap.rows).toHaveLength(1);
      expect(lap.rows[0]).toMatchObject({
        id: 1, session_id: 1, lap_number: 8, lap_time: 93.5, notes: "keep lap", is_favorite: 1,
      });

      await client.execute("UPDATE sessions SET lap_detector_version='repaired-current' WHERE id=1");
      await runMigrations(client);
      const resumed = await client.execute("SELECT lap_detector_version FROM sessions WHERE id=1");
      expect(resumed.rows[0]?.lap_detector_version).toBe("repaired-current");
    } finally {
      client.close();
    }
  });

});
