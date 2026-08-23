import { describe, test, expect } from "bun:test";
import {
  bootstrap,
  newClient,
  runMigrations,
} from "../../support/db/migrations";

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
    const sessionVersions = await client.execute(
      "SELECT id, lap_detector_version FROM sessions ORDER BY id",
    );
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
    const qualityRows = await client.execute(
      "SELECT quality, eligibility FROM laps WHERE lap_number IN (7, 8) ORDER BY lap_number",
    );
    expect(
      qualityRows.rows.map((row) => {
        const quality = JSON.parse(String(row.quality));
        const eligibility = JSON.parse(String(row.eligibility));
        return {
          phase: quality.classification.phase,
          paceEligibility: quality.classification.paceEligibility,
          structurallyValid: quality.structurallyValid,
          invalidReason: quality.invalidReason,
          factCodes: quality.facts.map(({ code }: { code: string }) => code),
          reason: eligibility["normal-pace"].reasons[0].code,
        };
      }),
    ).toEqual([
      {
        phase: "in",
        paceEligibility: "excluded",
        structurallyValid: true,
        invalidReason: null,
        factCodes: [
          "quality_not_rebuilt",
          "provenance_missing",
          "non_pace_classification",
        ],
        reason: "non_pace_classification",
      },
      {
        phase: "out",
        paceEligibility: "excluded",
        structurallyValid: true,
        invalidReason: null,
        factCodes: [
          "quality_not_rebuilt",
          "provenance_missing",
          "non_pace_classification",
        ],
        reason: "non_pace_classification",
      },
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
      "INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 10, 20, 'iracing')",
    );

    const rows = await client.execute("SELECT ownership FROM sessions WHERE id = 1");
    expect(rows.rows[0]?.ownership).toBe("mine");
    client.close();
  });


  test("v59 migrates v58 sessions and laps without classification columns", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 58);
    await client.execute(
      `INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id, source)
       VALUES (1, 10, 20, 'iracing', 'seed'),
              (2, 10, 20, 'iracing', NULL)`,
    );
    await client.execute(
      `INSERT INTO laps (session_id, lap_number, lap_time, is_valid, invalid_reason)
       VALUES (1, 1, 90, 1, NULL),
              (2, 1, 110, 0, 'offtrack')`,
    );
    await client.execute(
      `INSERT INTO lap_analyses (lap_id, analysis)
       VALUES (1, 'legacy lap analysis')`,
    );
    await client.execute(
      `INSERT INTO compare_analyses (lap_a_id, lap_b_id, analysis)
       VALUES (1, 2, 'legacy compare analysis')`,
    );

    await runMigrations(client, 59);

    const lapColumns = await client.execute("PRAGMA table_info(laps)");
    const cacheCounts = await client.execute(
      `SELECT
         (SELECT COUNT(*) FROM lap_analyses) AS lap_analysis_count,
         (SELECT COUNT(*) FROM compare_analyses) AS compare_analysis_count`,
    );
    expect({
      lapAnalysisCount: Number(cacheCounts.rows[0]?.lap_analysis_count),
      compareAnalysisCount: Number(cacheCounts.rows[0]?.compare_analysis_count),
    }).toEqual({
      lapAnalysisCount: 0,
      compareAnalysisCount: 0,
    });
    expect(lapColumns.rows.map((row) => String(row.name))).not.toEqual(
      expect.arrayContaining(["phase", "conditions", "pace_eligibility"]),
    );
    const sessionRows = await client.execute(
      `SELECT id, source, recording_quality, quality_schema_version,
              quality_policy_version, quality_config_version, quality_generation
       FROM sessions
       ORDER BY id`,
    );
    expect(
      sessionRows.rows.map((row) => {
        const quality = JSON.parse(String(row.recording_quality));
        return {
          id: Number(row.id),
          source: row.source,
          sourceKind: quality.sourceKind,
          facts: quality.facts.map(({ code, severity }: { code: string; severity: string }) => ({ code, severity })),
          provenance: quality.provenance,
          schemaVersion: row.quality_schema_version,
          policyVersion: row.quality_policy_version,
          configVersion: row.quality_config_version,
          generation: row.quality_generation,
        };
      }),
    ).toEqual([
      {
        id: 1,
        source: "seed",
        sourceKind: "unknown",
        facts: [
          { code: "quality_not_rebuilt", severity: "warning" },
          { code: "provenance_missing", severity: "error" },
        ],
        provenance: {
          schemaVersion: "legacy",
          policyVersion: "legacy",
          configurationVersion: "legacy",
          sourceGeneration: "legacy",
          outputGeneration: "legacy",
        },
        schemaVersion: "legacy",
        policyVersion: "legacy",
        configVersion: "legacy",
        generation: "legacy",
      },
      {
        id: 2,
        source: null,
        sourceKind: "unknown",
        facts: [
          { code: "quality_not_rebuilt", severity: "warning" },
          { code: "provenance_missing", severity: "error" },
        ],
        provenance: {
          schemaVersion: "legacy",
          policyVersion: "legacy",
          configurationVersion: "legacy",
          sourceGeneration: "legacy",
          outputGeneration: "legacy",
        },
        schemaVersion: "legacy",
        policyVersion: "legacy",
        configVersion: "legacy",
        generation: "legacy",
      },
    ]);

    const lapRows = await client.execute(
      `SELECT session_id, lap_number, quality, eligibility, quality_schema_version,
              quality_policy_version, quality_config_version, quality_generation
       FROM laps
       ORDER BY session_id, lap_number`,
    );
    expect(
      lapRows.rows.map((row) => {
        const quality = JSON.parse(String(row.quality));
        const eligibility = JSON.parse(String(row.eligibility));
        return {
          sessionId: Number(row.session_id),
          sourceKind: quality.sourceKind,
          lifecycleState: quality.lifecycleState,
          complete: quality.complete,
          structurallyValid: quality.structurallyValid,
          invalidReason: quality.invalidReason,
          timing: quality.timing,
          classification: quality.classification,
          provenance: quality.provenance,
          facts: quality.facts.map(
            ({ code, severity }: { code: string; severity: string }) => ({ code, severity }),
          ),
          officialTiming: {
            status: eligibility["official-timing"].status,
            reason: eligibility["official-timing"].reasons[0].code,
            severity: eligibility["official-timing"].reasons[0].severity,
          },
          normalPace: {
            status: eligibility["normal-pace"].status,
            reason: eligibility["normal-pace"].reasons[0].code,
            severity: eligibility["normal-pace"].reasons[0].severity,
          },
          schemaVersion: row.quality_schema_version,
          policyVersion: row.quality_policy_version,
          configVersion: row.quality_config_version,
          generation: row.quality_generation,
        };
      }),
    ).toEqual([
      {
        sessionId: 1,
        sourceKind: "unknown",
        lifecycleState: "unavailable",
        complete: true,
        structurallyValid: true,
        invalidReason: null,
        timing: {
          source: "simulator-history",
          lapTimeMs: 90_000,
          peakTelemetryLapTimeMs: null,
          confirmed: true,
        },
        classification: { phase: "flying", conditions: [], paceEligibility: "eligible" },
        provenance: {
          schemaVersion: "legacy",
          policyVersion: "legacy",
          configurationVersion: "legacy",
          sourceGeneration: "legacy",
          outputGeneration: "legacy",
        },
        facts: [
          { code: "quality_not_rebuilt", severity: "warning" },
          { code: "provenance_missing", severity: "error" },
        ],
        officialTiming: {
          status: "eligible_with_warning",
          reason: "quality_not_rebuilt",
          severity: "warning",
        },
        normalPace: {
          status: "eligible_with_warning",
          reason: "quality_not_rebuilt",
          severity: "warning",
        },
        schemaVersion: "legacy",
        policyVersion: "legacy",
        configVersion: "legacy",
        generation: "legacy",
      },
      {
        sessionId: 2,
        sourceKind: "unknown",
        lifecycleState: "unavailable",
        complete: true,
        structurallyValid: false,
        invalidReason: "offtrack",
        timing: {
          source: "simulator-history",
          lapTimeMs: 110_000,
          peakTelemetryLapTimeMs: null,
          confirmed: true,
        },
        classification: { phase: "flying", conditions: [], paceEligibility: "eligible" },
        provenance: {
          schemaVersion: "legacy",
          policyVersion: "legacy",
          configurationVersion: "legacy",
          sourceGeneration: "legacy",
          outputGeneration: "legacy",
        },
        facts: [
          { code: "quality_not_rebuilt", severity: "warning" },
          { code: "provenance_missing", severity: "error" },
        ],
        officialTiming: {
          status: "eligible_with_warning",
          reason: "quality_not_rebuilt",
          severity: "warning",
        },
        normalPace: {
          status: "ineligible",
          reason: "structurally_invalid",
          severity: "error",
        },
        schemaVersion: "legacy",
        policyVersion: "legacy",
        configVersion: "legacy",
        generation: "legacy",
      },
    ]);
    client.close();
  });
  test("v59 keeps other-driver legacy participants unknown and non-local", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 58);
    await client.execute(
      `INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id, ownership)
       VALUES (1, 10, 20, 'iracing', 'others')`,
    );
    await client.execute(
      `INSERT INTO laps (session_id, lap_number, lap_time, is_valid, invalid_reason)
       VALUES (1, 1, 90, 0, 'pit lap')`,
    );

    await runMigrations(client, 59);

    const sessionRow = await client.execute(
      "SELECT recording_quality FROM sessions WHERE id = 1",
    );
    const lapRow = await client.execute(
      "SELECT quality, invalid_reason FROM laps WHERE session_id = 1",
    );
    expect(JSON.parse(String(sessionRow.rows[0]?.recording_quality)).participant).toEqual({
      kind: "opponent",
      sourceId: null,
      stableId: null,
      identityState: "unknown",
    });
    const lapQuality = JSON.parse(String(lapRow.rows[0]?.quality));
    expect(lapQuality.participant).toEqual({
      kind: "opponent",
      sourceId: null,
      stableId: null,
      identityState: "unknown",
    });
    expect(lapQuality).toMatchObject({
      invalidReason: null,
      structurallyValid: true,
      classification: {
        phase: "pit",
        conditions: [],
        paceEligibility: "excluded",
      },
    });
    expect(lapRow.rows[0]?.invalid_reason).toBe("pit lap");
    expect(lapQuality.facts.map(({ code }: { code: string }) => code)).toContain(
      "non_pace_classification",
    );
    client.close();
  });

  test("v59 preserves nullable source profiles and round-trips profile JSON", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 58);
    await client.execute(
      `INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id, source)
       VALUES (1, 10, 20, 'iracing', 'native-live'),
              (2, 10, 20, 'iracing', 'motec')`,
    );

    await runMigrations(client, 59);

    const profile = {
      schemaVersion: "1",
      sourceKind: "motec",
      channels: {
        "motion.speed": {
          treatment: "resampled",
          mappingStatus: "normalized",
          sourceChannels: [{ name: "Ground Speed", declaredHz: 50, effectiveHz: 20 }],
          limitations: ["resampled export"],
          evidenceId: "source-profile:speed",
        },
      },
    };
    await client.execute({
      sql: "UPDATE sessions SET source_channel_profile = ? WHERE id = 2",
      args: [JSON.stringify(profile)],
    });

    const rows = await client.execute(
      "SELECT id, source_channel_profile FROM sessions ORDER BY id",
    );
    expect(rows.rows[0]?.source_channel_profile).toBeNull();
    expect(JSON.parse(String(rows.rows[1]?.source_channel_profile))).toEqual(profile);
    client.close();
  });

  test("v59 adds quality generation without overwriting existing lap metrics", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 58);
    await client.execute(
      "INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 10, 20, 'iracing')",
    );
    await client.execute(
      "INSERT INTO laps (id, session_id, lap_number, lap_time, is_valid) VALUES (1, 1, 1, 90, 1)",
    );
    await client.execute({
      sql: `INSERT INTO lap_metrics (lap_id, algo_version, insights, segment_stats)
            VALUES (?, ?, ?, ?)`,
      args: [1, 7, JSON.stringify([{ kind: "braking" }]), JSON.stringify([{ segment: 1 }])],
    });

    await runMigrations(client, 59);

    const columns = await client.execute("PRAGMA table_info(lap_metrics)");
    expect(columns.rows.map((row) => String(row.name))).toContain("quality_generation");
    const row = await client.execute(
      "SELECT lap_id, algo_version, insights, segment_stats, quality_generation FROM lap_metrics WHERE lap_id = 1",
    );
    const metric = row.rows[0];
    expect({
      lap_id: metric?.lap_id,
      algo_version: metric?.algo_version,
      insights: metric?.insights,
      segment_stats: metric?.segment_stats,
      quality_generation: metric?.quality_generation,
    }).toEqual({
      lap_id: 1,
      algo_version: 7,
      insights: JSON.stringify([{ kind: "braking" }]),
      segment_stats: JSON.stringify([{ segment: 1 }]),
      quality_generation: null,
    });
    client.close();
  });

  test("v59 restores pit_events after overlapping migration histories", async () => {
    const client = newClient();
    await bootstrap(client);
    await runMigrations(client, 58);
    await client.execute("DROP TABLE pit_events");
    expect(await runMigrations(client, 59)).toBe(1);

    const columns = await client.execute("PRAGMA table_info(pit_events)");
    expect(columns.rows.map((row) => String(row.name))).toEqual([
      "id",
      "result_id",
      "sequence",
      "event_type",
      "position_before",
      "position_after",
      "lap_number",
      "elapsed_seconds",
      "duration_seconds",
      "service",
      "tyre_change",
      "fuel_added",
      "fuel_before",
      "fuel_after",
      "linkage",
      "source",
      "created_at",
    ]);
    await client.execute(
      "INSERT INTO sessions (id, car_ordinal, track_ordinal, game_id) VALUES (1, 10, 20, 'iracing')",
    );
    await client.execute(
      "INSERT INTO session_results (id, session_id) VALUES (1, 1)",
    );
    await client.execute(
      "INSERT INTO pit_events (result_id, sequence, lap_number) VALUES (1, 1, 42)",
    );
    const rows = await client.execute(
      "SELECT event_type, linkage, lap_number FROM pit_events",
    );
    expect(
      rows.rows.map((row) => ({
        eventType: String(row.event_type),
        linkage: String(row.linkage),
        lapNumber: Number(row.lap_number),
      })),
    ).toEqual([
      { eventType: "pit", linkage: "unknown", lapNumber: 42 },
    ]);
    client.close();
  });
});
