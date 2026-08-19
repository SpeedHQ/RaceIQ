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

  test("v59 persists final lap classification and converts only legacy pit reasons", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 58);
    await client.execute(
      "INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 10, 20, 'iracing')",
    );
    await client.execute(
      `INSERT INTO laps (session_id, lap_number, lap_time, is_valid, invalid_reason)
       VALUES (1, 1, 100, 1, NULL),
              (1, 2, 101, 0, 'outlap'),
              (1, 3, 102, 0, 'inlap'),
              (1, 4, 103, 0, 'pit lap'),
              (1, 5, 104, 0, 'track limits')`,
    );

    await runMigrations(client, 59);

    const rows = await client.execute(
      `SELECT lap_number, is_valid, invalid_reason, phase, conditions, pace_eligibility
       FROM laps
       ORDER BY lap_number`,
    );
    expect(
      rows.rows.map((row) => ({
        lapNumber: Number(row.lap_number),
        isValid: Number(row.is_valid),
        invalidReason: row.invalid_reason,
        phase: String(row.phase),
        conditions: JSON.parse(String(row.conditions)),
        paceEligibility: String(row.pace_eligibility),
      })),
    ).toEqual([
      {
        lapNumber: 1,
        isValid: 1,
        invalidReason: null,
        phase: "flying",
        conditions: [],
        paceEligibility: "eligible",
      },
      {
        lapNumber: 2,
        isValid: 1,
        invalidReason: null,
        phase: "out",
        conditions: [],
        paceEligibility: "excluded",
      },
      {
        lapNumber: 3,
        isValid: 1,
        invalidReason: null,
        phase: "in",
        conditions: [],
        paceEligibility: "excluded",
      },
      {
        lapNumber: 4,
        isValid: 1,
        invalidReason: null,
        phase: "pit",
        conditions: [],
        paceEligibility: "excluded",
      },
      {
        lapNumber: 5,
        isValid: 0,
        invalidReason: "track limits",
        phase: "flying",
        conditions: [],
        paceEligibility: "eligible",
      },
    ]);
    const columns = await client.execute("PRAGMA table_info(laps)");
    const columnNames = columns.rows.map((row) => String(row.name));
    expect(columnNames).toContain("phase");
    expect(columnNames).toContain("conditions");
    expect(columnNames).toContain("pace_eligibility");
    expect(columnNames).not.toContain("classification");
    client.close();
  });

  test("v60 preserves explicit sources and backfills legacy live provenance", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 59);
    await client.execute(
      `INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id, source)
       VALUES (1, 10, 20, 'iracing', 'motec'),
              (2, 11, 21, 'acc', NULL)`,
    );
    await client.execute(
      `INSERT INTO laps (session_id, lap_number, lap_time, is_valid, phase, conditions, pace_eligibility)
       VALUES (1, 1, 100, 1, 'flying', '[]', 'eligible'),
              (1, 2, 75, 1, 'pit', '[]', 'excluded'),
              (2, 1, 90, 1, 'flying', '[]', 'eligible')`,
    );

    await runMigrations(client);

    const sessionRows = await client.execute(
      "SELECT id, source, recording_quality, quality_generation FROM sessions ORDER BY id",
    );
    const migratedSessions = sessionRows.rows.map((row) => ({
      id: Number(row.id),
      source: String(row.source),
      quality: JSON.parse(String(row.recording_quality)),
      generation: String(row.quality_generation),
    }));
    expect(migratedSessions.map(({ id, source, quality }) => ({ id, source, sourceKind: quality.sourceKind }))).toEqual([
      { id: 1, source: "motec", sourceKind: "motec" },
      { id: 2, source: "native-live", sourceKind: "native-live" },
    ]);
    expect(migratedSessions.every(({ quality }) => quality.lifecycleState === "unavailable")).toBe(true);
    expect(migratedSessions.every(({ quality }) => quality.facts.some(({ code }: { code: string }) => code === "quality_not_rebuilt"))).toBe(true);
    expect(migratedSessions.every(({ generation }) => generation === "legacy")).toBe(true);

    const rows = await client.execute("SELECT session_id, lap_number, quality, eligibility, quality_generation FROM laps ORDER BY session_id, lap_number");
    const migrated = rows.rows.map((row) => ({
      sessionId: Number(row.session_id),
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
    expect(migrated[2]?.quality.sourceKind).toBe("native-live");
    client.close();
  });

  test("v61 adds nullable source channel profiles without inventing legacy fidelity", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 60);
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

  test("v62 versions lap metrics without inventing generations for existing rows", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 61);
    await client.execute("INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 10, 20, 'f1-2025')");
    await client.execute("INSERT INTO laps (id, session_id, lap_number, lap_time) VALUES (1, 1, 1, 100)");
    await client.execute(
      `INSERT INTO lap_metrics (lap_id, algo_version, insights, segment_stats, computed_at)
       VALUES (1, 2, '[]', '[]', '2026-01-01T00:00:00.000Z')`,
    );

    await runMigrations(client);

    const columns = await client.execute("PRAGMA table_info(lap_metrics)");
    expect(columns.rows.map((row) => String(row.name))).toContain("quality_generation");
    const row = (await client.execute("SELECT quality_generation, computed_at FROM lap_metrics WHERE lap_id = 1")).rows[0]!;
    expect(row.quality_generation).toBeNull();
    expect(row.computed_at).toBe("2026-01-01T00:00:00.000Z");
    client.close();
  });

  test("v63 backfills canonical events, preserves durable ids, and removes the pit ledger", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 62);
    await client.execute(
      `INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id, source)
       VALUES (1, 10, 20, 'iracing', 'native-live')`,
    );
    await client.execute(
      `INSERT INTO laps (id, session_id, lap_number, lap_time)
       VALUES (11, 1, 7, 100), (12, 1, 8, 99)`,
    );
    await client.execute(
      `INSERT INTO session_results (
         id, session_id, session_type, classification, pit_count,
         processor_version, outcome_status
       )
       VALUES (21, 1, 'race', 'finished', 1, 'race-result-v2', 'confirmed')`,
    );
    await client.execute({
      sql: `INSERT INTO pit_events (
         id, result_id, sequence, event_type, position_before, position_after,
         lap_number, elapsed_seconds, duration_seconds, service, tyre_change,
         fuel_added, fuel_before, fuel_after, linkage, source, created_at
       ) VALUES
         (31, 21, 4, 'pit', NULL, NULL, 7, 700.25, 31.5, 'combined', ?, 12.5, 10, 22.5, 'linked', '{}', '2026-01-02 03:04:05'),
         (32, 21, 5, 'position-change', 8, 5, 8, 800, NULL, 'unknown', NULL, NULL, NULL, NULL, 'linked', '{}', '2026-01-02 03:05:05')`,
      args: [JSON.stringify({ from: "soft", to: "medium" })],
    });

    await runMigrations(client, 63);

    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    const tableNames = tables.rows.map((row) => String(row.name));
    expect(tableNames).toContain("race_events");
    expect(tableNames).not.toContain("pit_events");

    const eventRows = await client.execute(
      `SELECT event_id, event_type, session_id, participant_id, timeline_epoch,
              sequence, event_order, source_time_ms, source_end_time_ms,
              lap_id, evidence_kind, confidence, quality_state, source_kind,
              payload, lifecycle_id, linked_event_id, detector_id,
              detector_version, source_generation, content_hash, created_at
       FROM race_events
       ORDER BY timeline_epoch, sequence, event_order, event_id`,
    );
    const migrated: Array<Record<string, unknown>> = eventRows.rows.map((row) => ({
      ...(row as Record<string, unknown>),
      payload: JSON.parse(String(row.payload)),
    }));
    expect(migrated.map((event) => event.event_id)).toEqual([
      "pit-event:31",
      "pit-event:31:fuel-service",
      "pit-event:31:tire-service",
      "position-event:32",
    ]);
    expect(migrated[0]).toMatchObject({
      event_type: "pit_entry",
      session_id: 1,
      participant_id: "local-player",
      timeline_epoch: 0,
      sequence: 4,
      event_order: 50,
      source_time_ms: 700250,
      source_end_time_ms: 700250,
      lap_id: 11,
      evidence_kind: "derived",
      confidence: "unknown",
      quality_state: "ambiguous",
      source_kind: "native-live",
      payload: { previousState: "unknown", state: "pit-lane" },
      lifecycle_id: "legacy:pit-visit:31",
      linked_event_id: null,
      detector_id: "legacy-race-result",
      detector_version: "legacy-v1",
      source_generation: "legacy",
      content_hash: null,
      created_at: "2026-01-02T03:04:05.000Z",
    });
    expect(migrated[1]).toMatchObject({
      event_type: "fuel_service_observed",
      event_order: 60,
      linked_event_id: "pit-event:31",
      payload: { beforeLitres: 10, afterLitres: 22.5, addedLitres: 12.5 },
    });
    expect(migrated[2]).toMatchObject({
      event_type: "tire_service_observed",
      event_order: 60,
      linked_event_id: "pit-event:31",
      payload: {
        changedCorners: [],
        previousCompound: "soft",
        currentCompound: "medium",
        beforeWear: null,
        afterWear: null,
      },
    });
    expect(migrated[3]).toMatchObject({
      event_type: "position_changed",
      event_order: 20,
      lifecycle_id: null,
      payload: { previousPosition: 8, position: 5 },
    });

    const resultRow = (
      await client.execute("SELECT event_ids FROM session_results WHERE id = 21")
    ).rows[0]!;
    expect(JSON.parse(String(resultRow.event_ids))).toEqual([
      "pit-event:31",
      "pit-event:31:fuel-service",
      "pit-event:31:tire-service",
      "position-event:32",
    ]);

    await client.execute("DELETE FROM laps WHERE id = 11");
    const lapLinks = await client.execute(
      "SELECT event_id, lap_id FROM race_events WHERE event_id LIKE 'pit-event:31%' ORDER BY event_id",
    );
    expect(lapLinks.rows.every((row) => row.lap_id === null)).toBe(true);

    await client.execute("DELETE FROM race_events WHERE event_id = 'pit-event:31'");
    const selfLinks = await client.execute(
      "SELECT linked_event_id FROM race_events WHERE event_id LIKE 'pit-event:31:%'",
    );
    expect(selfLinks.rows.every((row) => row.linked_event_id === null)).toBe(true);

    await client.execute("DELETE FROM sessions WHERE id = 1");
    const remaining = await client.execute("SELECT count(*) AS count FROM race_events");
    expect(Number(remaining.rows[0]!.count)).toBe(0);
    client.close();
  });

  test("v64 adds semantic run artifacts without inventing historical runs", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 63);
    await client.execute(
      `INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id)
       VALUES (1, 10, 20, 'iracing')`,
    );
    await client.execute(
      `INSERT INTO laps (id, session_id, lap_number, lap_time)
       VALUES (11, 1, 7, 90)`,
    );
    for (const [eventId, eventType, sequence] of [
      ["race-event:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "participant_joined", 1],
      ["race-event:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "lap_completed", 2],
      ["race-event:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", "session_ended", 3],
    ] as const) {
      await client.execute({
        sql: `INSERT INTO race_events (
          event_id, event_type, schema_version, session_id, timeline_epoch,
          sequence, event_order, received_at_ms, evidence_kind, confidence,
          quality_state, source_kind, payload, detector_id, detector_version,
          created_at
        ) VALUES (?, ?, 'race-event-v1', 1, 0, ?, 10, ?, 'observed',
          'high', 'available', 'native-live', '{}', 'test', '1',
          '2026-08-19T00:00:00.000Z')`,
        args: [eventId, eventType, sequence, sequence * 1_000],
      });
    }

    await runMigrations(client, 64);
    for (const table of [
      "session_runs",
      "session_run_laps",
      "session_run_evidence",
    ]) {
      const rows = await client.execute(`SELECT count(*) AS count FROM ${table}`);
      expect(Number(rows.rows[0]!.count)).toBe(0);
    }

    const runId =
      "session-run:sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
    await client.execute({
      sql: `INSERT INTO session_runs (
        run_id, schema_version, algorithm_version, session_id, run_kind,
        status, opening_phase, observed_phases, timeline_epoch,
        opening_sequence, opening_event_order, opening_reason,
        opening_event_id, opening_confidence, opening_evidence_kind,
        closing_reason, closing_event_id, closing_confidence,
        closing_evidence_kind, start_lap_event_id, end_lap_event_id,
        start_lap_id, end_lap_id, quality_flags, summary, content_hash,
        created_at
      ) VALUES (?, 'session-run-v1', 'session-run-builder-v1', 1, 'tire',
        'complete', 'green', '["green"]', 0, 1, 10, 'participant_joined',
        'race-event:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'high', 'observed', 'session_ended',
        'race-event:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        'high', 'observed',
        'race-event:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        'race-event:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        11, 11, '[]', '{}',
        'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
        '2026-08-19T00:00:00.000Z')`,
      args: [runId],
    });
    await client.execute({
      sql: `INSERT INTO session_run_laps (
        run_id, lap_event_id, lap_id, lap_number, ordinal, entry_event_id,
        exit_event_id
      ) VALUES (?, ?, 11, 7, 0, ?, ?)`,
      args: [
        runId,
        "race-event:sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        "race-event:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "race-event:sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      ],
    });
    await client.execute({
      sql: `INSERT INTO session_run_evidence (run_id, event_id, role)
            VALUES (?, ?, 'opening')`,
      args: [
        runId,
        "race-event:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ],
    });
    await expect(
      client.execute({
        sql: `INSERT INTO session_runs (
          run_id, schema_version, algorithm_version, session_id, run_kind,
          status, opening_phase, observed_phases, timeline_epoch,
          opening_sequence, opening_event_order, opening_reason,
          opening_event_id, opening_confidence, opening_evidence_kind,
          closing_reason, closing_event_id, closing_confidence,
          closing_evidence_kind, quality_flags, summary, content_hash, created_at
        ) SELECT ?, schema_version, algorithm_version, session_id, run_kind,
          status, opening_phase, observed_phases, timeline_epoch,
          opening_sequence, opening_event_order, opening_reason,
          opening_event_id, opening_confidence, opening_evidence_kind,
          closing_reason, closing_event_id, closing_confidence,
          closing_evidence_kind, quality_flags, summary, content_hash, created_at
          FROM session_runs WHERE run_id = ?`,
        args: [
          "session-run:sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
          runId,
        ],
      }),
    ).rejects.toThrow();

    await client.execute("DELETE FROM laps WHERE id = 11");
    const nullableLinks = (
      await client.execute(
        "SELECT start_lap_id, end_lap_id FROM session_runs WHERE run_id = ?",
        [runId],
      )
    ).rows[0]!;
    expect(nullableLinks.start_lap_id).toBeNull();
    expect(nullableLinks.end_lap_id).toBeNull();
    const membership = (
      await client.execute(
        "SELECT lap_id FROM session_run_laps WHERE run_id = ?",
        [runId],
      )
    ).rows[0]!;
    expect(membership.lap_id).toBeNull();

    await client.execute(
      "DELETE FROM race_events WHERE event_id = 'race-event:sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
    );
    const remaining = await client.execute(
      "SELECT count(*) AS count FROM session_runs",
    );
    expect(Number(remaining.rows[0]!.count)).toBe(0);
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
      "INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 10, 20, 'iracing')",
    );

    const rows = await client.execute("SELECT ownership FROM sessions WHERE id = 1");
    expect(rows.rows[0]?.ownership).toBe("mine");
    client.close();
  });

});
