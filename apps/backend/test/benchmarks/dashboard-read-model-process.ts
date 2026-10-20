import { mkdirSync } from "node:fs";
import { arch, cpus } from "node:os";
import { DB_PATH, client, initDb } from "@raceiq/backend-core/db/index";
import { runMitataBenchmarks } from "./mitata-harness";
import { dashboardRoutes } from "../../src/routes/dashboard-routes";
import { getDashboard } from "@raceiq/backend-core/db/dashboard-queries";
import { getDashboardSessionRecap } from "@raceiq/backend-core/db/dashboard-recap-queries";
import { createDashboardFixture, DASHBOARD_FIXTURE_HISTORY_END, drainDashboardFixture, type DashboardFixtureMetadata } from "./dashboard-read-model-fixture";
import { sourceDashboardReference } from "./dashboard-read-model-reference";
import { sourceRecapMetricOracle } from "./dashboard-recap-reference";
import { dashboardSqlMeasurement, installDashboardSqlInstrumentation, resetDashboardSqlMeasurement, type CapturedSql, type SqlMeasurement } from "./dashboard-read-model-instrumentation";
import { bench, group } from "mitata";
import type { DashboardRequest, DashboardResponse } from "@raceiq/shared/racing/sessions/dashboard";

const mode = process.argv[2] ?? process.env.DASHBOARD_FIXTURE_MODE ?? "smoke";
const historyEnd = Date.parse(DASHBOARD_FIXTURE_HISTORY_END);
const dayBeforeHistoryEnd = new Date(historyEnd - 86_400_000).toISOString();
const weekBeforeHistoryEnd = new Date(historyEnd - 7 * 86_400_000).toISOString();
const baseRequest: DashboardRequest = { from: "2025-01-01T00:00:00.000Z", to: DASHBOARD_FIXTURE_HISTORY_END };
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function equal(actual: unknown, expected: unknown, label: string) {
  if (typeof actual === "number" && typeof expected === "number") {
    if (!Number.isFinite(actual) || !Number.isFinite(expected) || Math.abs(actual - expected) > Math.max(1e-6, Math.abs(expected) * 1e-9)) throw new Error(`${label}: actual ${actual}, expected ${expected}`);
  } else if (actual !== expected) throw new Error(`${label}: actual ${String(actual)}, expected ${String(expected)}`);
}
function assertEquivalent(actual: unknown, expected: unknown, label: string): void {
  if (typeof expected === "number") { equal(actual, expected, label); return; }
  if (expected === null || typeof expected !== "object") { equal(actual, expected, label); return; }
  assert(actual !== null && typeof actual === "object", `${label}: response shape differs`);
  if (Array.isArray(expected)) {
    assert(Array.isArray(actual) && actual.length === expected.length, `${label}: array length differs`);
    for (let index = 0; index < expected.length; index++) assertEquivalent(actual[index], expected[index], `${label}[${index}]`);
    return;
  }
  for (const [key, value] of Object.entries(expected)) assertEquivalent(Reflect.get(actual, key), value, `${label}.${key}`);
}
function assertDashboardMetrics(actual: DashboardResponse, expected: DashboardResponse): void {
  for (const key of ["coverage", "cards", "totals", "calendar", "trackDistribution", "favouriteTrack", "favouriteCar", "consistency", "sessionTypes", "podiums", "recentSessions", "latestRecapSessionId"] as const) {
    assertEquivalent(actual[key], expected[key], key);
  }
  assert(actual.recentSessions.length <= 10, "recent session limit exceeds 10");
  assert(actual.trackDistribution.topFive.length <= 5, "track distribution exceeds top five");
  assert(actual.calendar.length <= 367, "calendar series exceeds 367 days");
}
interface ExplainedSql { sql: string; rowsReturned: number; detail: string[] }
async function explainMeasuredQueries(queries: CapturedSql[]) {
  const output: ExplainedSql[] = [];
  for (const query of queries) {
    if (!/^\s*(?:SELECT|WITH)\b/i.test(query.sql)) continue;
    const result = await client.execute({ sql: `EXPLAIN QUERY PLAN ${query.sql}`, args: Array.isArray(query.args) ? query.args : [] });
    output.push({ sql: query.sql, rowsReturned: query.rowsReturned, detail: result.rows.map((row) => String(row.detail ?? "")) });
  }
  return output;
}
await initDb();
installDashboardSqlInstrumentation();
const dashboardServer = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: dashboardRoutes.fetch });
async function measureRequest<T>(run: () => Promise<T>) {
  const baseline = process.memoryUsage().rss;
  let peak = baseline;
  const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 1);
  const start = process.hrtime.bigint();
  let value!: T;
  try { value = await run(); }
  finally { clearInterval(sampler); peak = Math.max(peak, process.memoryUsage().rss); }
  return { value, elapsedMs: Number(process.hrtime.bigint() - start) / 1e6, rssDeltaBytes: Math.max(0, peak - baseline) };
}
async function assertDataset(lapCount: number, sessionCount: number, distribution: "standard" | "boundary-heavy") {
  let boundarySql: SqlMeasurement | null = null;
  let boundaryExplain: ExplainedSql[] = [];
  const fixture = await createDashboardFixture({ lapCount, sessionCount, seed: 211211, distribution, publish: true });
  const request = distribution === "boundary-heavy" ? { ...baseRequest, from: "2024-01-01T00:00:00.000Z", to: "2025-01-01T00:00:00.000Z" } : baseRequest;
  resetDashboardSqlMeasurement();
  const measured = await measureRequest(() => getDashboard(request));
  const response = measured.value;
  const aggregateSql = dashboardSqlMeasurement();
  assert(response.coverage.metadataComplete, `${distribution}/${lapCount}: metadataComplete false; coverage=${JSON.stringify(response.coverage)}`);
  assert(response.coverage.readySessions === response.coverage.mineSessions, `${distribution}/${lapCount}: fully backfilled metadata not ready`);
  assert(aggregateSql.statements <= 12, `dashboard query used ${aggregateSql.statements} statements; budget 12`);
  assert(new TextEncoder().encode(JSON.stringify(response)).byteLength <= 128 * 1024, "dashboard payload exceeds 128 KiB");
  assert(aggregateSql.sourceQueries.laps === 0, `unexpected raw laps source queries: ${aggregateSql.sourceQueries.laps}`);
  assertDashboardMetrics(response, await sourceDashboardReference(request));
  resetDashboardSqlMeasurement();
  const recap = await getDashboardSessionRecap(fixture.latestRecapSessionId, fixture.latestRecapGameId);
  const recapSql = dashboardSqlMeasurement();
  assert(recap !== null, "latest recap session missing");
  assert(recapSql.statements <= 8, `recap query used ${recapSql.statements} statements; budget 8`);
  const expectedRecap = await sourceRecapMetricOracle(fixture.latestRecapSessionId, fixture.latestRecapGameId);
  assertEquivalent(recap, expectedRecap, "recap");
  if (distribution === "boundary-heavy") {
    const singleDayRequest: DashboardRequest = { ...request, from: "2024-01-02T00:00:00.000Z", to: "2024-01-03T00:00:00.000Z" };
    resetDashboardSqlMeasurement();
    const boundary = await getDashboard(singleDayRequest);
    boundarySql = dashboardSqlMeasurement();
    assert(boundary.coverage.metadataComplete, `boundary/day: metadataComplete false; coverage=${JSON.stringify(boundary.coverage)}`);
    assert(boundary.coverage.readySessions === boundary.coverage.mineSessions, "boundary/day: fully backfilled metadata not ready");
    assert(boundarySql.sourceQueries.boundaryLapIndex > 0, `boundary lap-index source queries not observed: ${JSON.stringify(boundarySql.sourceQueries)}`);
    assertDashboardMetrics(boundary, await sourceDashboardReference(singleDayRequest));
    boundaryExplain = await explainMeasuredQueries(boundarySql.queries);
  }
  assert(lapCount < 1_000_000 || measured.rssDeltaBytes <= 64 * 1024 * 1024,
    `request RSS grew ${measured.rssDeltaBytes} bytes; budget 67108864`);
  const explain = await explainMeasuredQueries(aggregateSql.queries);
  return { fixture, response, explain, boundarySql, boundaryExplain, rssDeltaBytes: measured.rssDeltaBytes,
    elapsedMs: measured.elapsedMs, aggregateSql, recapSql, runtime: process.versions, architecture: arch(),
    cpu: cpus()[0]?.model ?? null };
}

const SHAPE_MODES = ["smoke-standard-small", "smoke-standard-large", "smoke-boundary"] as const;
const BENCH_MODES = ["bench-realistic", "bench-archive-100k", "bench-archive-1m", "bench-boundary"] as const;
const scopes = ["aggregate", "recap", "boundary"] as const;
type ReadScope = typeof scopes[number];
type RecapTarget = Pick<DashboardFixtureMetadata, "latestRecapSessionId" | "latestRecapGameId">;
function requestFor(scope: ReadScope, period: DashboardRequest): DashboardRequest {
  if (scope === "boundary") return { ...period, from: "2024-01-02T00:00:00.000Z", to: "2024-01-03T00:00:00.000Z" };
  return period;
}
async function runScope(scope: ReadScope, request: DashboardRequest, fixture: RecapTarget) {
  let url: string;
  const headers: Record<string, string> = {};
  if (scope === "recap") {
    url = `/api/dashboard/sessions/${fixture.latestRecapSessionId}/recap`;
    headers["X-Game-Id"] = fixture.latestRecapGameId;
  } else {
    const query = new URLSearchParams({ from: request.from, to: request.to });
    url = `/api/dashboard?${query}`;
    if (request.gameId) headers["X-Game-Id"] = request.gameId;
  }
  const response = await fetch(`http://127.0.0.1:${dashboardServer.port}${url}`, { headers });
  const text = await response.text();
  assert(response.ok, `Dashboard ${scope} GET failed ${response.status}: ${text}`);
  return { value: JSON.parse(text) as unknown, payloadBytes: new TextEncoder().encode(text).byteLength };
}
function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)] ?? Number.NaN;
}
function coldProbe(scope: ReadScope, request: DashboardRequest, fixture: RecapTarget) {
  assert(process.env.DATA_DIR, "Cold probes require fixture DATA_DIR");
  const child = Bun.spawnSync([process.execPath, "run", "apps/backend/test/benchmarks/dashboard-read-model-process.ts", "cold-one",
    scope, request.from, request.to, request.gameId ?? "", String(fixture.latestRecapSessionId), fixture.latestRecapGameId], {
    cwd: process.cwd(), env: { ...process.env, RACEIQ_TEST_MODE: "0" }, stdin: "ignore", stdout: "pipe", stderr: "inherit",
  });
  if (child.exitCode !== 0) throw new Error(`Cold probe failed for ${scope}/${request.from}: ${Buffer.from(child.stdout).toString()}`);
  return JSON.parse(Buffer.from(child.stdout).toString()) as { elapsedMs: number; rssDeltaBytes: number; payloadBytes: number; sql: SqlMeasurement };
}
if (mode === "cold-one") {
  const [, , , scopeArg, from, to, gameId, sessionId, recapGameId] = process.argv;
  const scope = scopeArg as ReadScope;
  const request: DashboardRequest = { from: from!, to: to!, ...(gameId ? { gameId: gameId as DashboardRequest["gameId"] } : {}) };
  resetDashboardSqlMeasurement();
  const fixture: RecapTarget = { latestRecapSessionId: Number(sessionId), latestRecapGameId: recapGameId as NonNullable<DashboardRequest["gameId"]> };
  const measured = await measureRequest(() => runScope(scope, request, fixture));
  console.log(JSON.stringify({ elapsedMs: measured.elapsedMs, rssDeltaBytes: measured.rssDeltaBytes, payloadBytes: measured.value.payloadBytes, sql: dashboardSqlMeasurement() }));
} else if (SHAPE_MODES.includes(mode as typeof SHAPE_MODES[number])) {
  const shape = mode === "smoke-standard-small" ? [100_000, 10_000, "standard"] as const
    : mode === "smoke-standard-large" ? [1_000_000, 100_000, "standard"] as const : [1_000_000, 100_000, "boundary-heavy"] as const;
  const [lapCount, sessionCount, distribution] = shape;
  const result = await assertDataset(lapCount, sessionCount, distribution);
  console.log(JSON.stringify({ measurementSemantics: { rowCounts: "SQL result rows returned, not rows scanned", explain: "query plan only; physical visits not measured" },
    dataDir: process.env.DATA_DIR, dbPath: DB_PATH, fixture: result.fixture.options, coverage: result.response.coverage,
    processorVersion: 5, payloadBytes: new TextEncoder().encode(JSON.stringify(result.response)).byteLength, rssDeltaBytes: result.rssDeltaBytes,
    elapsedMs: result.elapsedMs, aggregateSql: result.aggregateSql, recapSql: result.recapSql, explain: result.explain,
    boundarySql: result.boundarySql, boundaryExplain: result.boundaryExplain,
    gameCounts: result.fixture.gameCounts, identityCounts: result.fixture.identityCounts,
    runtime: result.runtime, architecture: result.architecture, cpu: cpus()[0]?.model ?? null }));
} else if (BENCH_MODES.includes(mode as typeof BENCH_MODES[number])) {
  const shape = mode === "bench-realistic" ? [12_480, 1_248, "standard"] as const
    : mode === "bench-archive-100k" ? [100_000, 10_000, "standard"] as const
      : mode === "bench-archive-1m" ? [1_000_000, 100_000, "standard"] as const
        : [1_000_000, 100_000, "boundary-heavy"] as const;
  const [lapCount, sessionCount, distribution] = shape;
  const fixture = await createDashboardFixture({ lapCount, sessionCount, seed: 211211, distribution, publish: true,
    profile: mode === "bench-realistic" ? "active-user" : "archive-stress" });
  resetDashboardSqlMeasurement();
  const baselineResponse = await getDashboard(baseRequest);
  const baselineSql = dashboardSqlMeasurement();
  for (const period of fixture.requestScopes) {
    const periodResponse = await getDashboard(period);
    assert(periodResponse.coverage.metadataComplete, `${distribution}/${period.from}: metadata incomplete before timing`);
    assert(periodResponse.coverage.readySessions === periodResponse.coverage.mineSessions,
      `${distribution}/${period.from}: metadata backfill incomplete before timing`);
  }
  let boundaryAcceptance: { coverage: DashboardResponse["coverage"]; sql: SqlMeasurement; explain: ExplainedSql[] } | null = null;
  if (distribution === "boundary-heavy") {
    const boundaryRequest = { ...baseRequest, from: "2024-01-02T00:00:00.000Z", to: "2024-01-03T00:00:00.000Z" };
    resetDashboardSqlMeasurement();
    const day = await getDashboard(boundaryRequest);
    const boundarySql = dashboardSqlMeasurement();
    assert(day.coverage.metadataComplete && day.coverage.readySessions === day.coverage.mineSessions, "boundary/day metadata incomplete before timing");
    assert(boundarySql.sourceQueries.boundaryLapIndex > 0, `boundary lap-index source queries not observed: ${JSON.stringify(boundarySql.sourceQueries)}`);
    assert(boundarySql.statements <= 12, `boundary/day query used ${boundarySql.statements} statements; budget 12`);
    assertDashboardMetrics(day, await sourceDashboardReference(boundaryRequest));
    boundaryAcceptance = { coverage: day.coverage, sql: boundarySql, explain: await explainMeasuredQueries(boundarySql.queries) };
  }
  const baselineExplain = await explainMeasuredQueries(baselineSql.queries);
  const failures: string[] = [];
  const records: Array<Record<string, unknown>> = [];
  const gameIds = ["fm-2023", "f1-2025", "acc", "ac-evo", "iracing", "lmu"] as const;
  const periodRanges = [
    { period: "day", from: dayBeforeHistoryEnd, to: DASHBOARD_FIXTURE_HISTORY_END },
    { period: "week", from: weekBeforeHistoryEnd, to: DASHBOARD_FIXTURE_HISTORY_END },
    { period: "month", from: "2025-12-01T00:00:00.000Z", to: DASHBOARD_FIXTURE_HISTORY_END },
    { period: "quarter", from: "2025-10-01T00:00:00.000Z", to: DASHBOARD_FIXTURE_HISTORY_END },
    { period: "year", from: "2025-01-01T00:00:00.000Z", to: DASHBOARD_FIXTURE_HISTORY_END },
  ] as const;
  const benchmarkPeriods = periodRanges.flatMap(({ period, ...request }) => [
    { period, request },
    ...gameIds.map((gameId) => ({ period, request: { ...request, gameId } })),
  ]);
  mkdirSync(".omp/evidence/sqlite-dashboard", { recursive: true });
  const evidencePath = `.omp/evidence/sqlite-dashboard/dashboard-read-model-${mode}.acceptance.json`;
  const persistMeasurements = (status: "incomplete" | "failed" | "passed", mitata: unknown = null) => Bun.write(evidencePath, JSON.stringify({
    status, failures, mitata,
    measurementSemantics: { rowCounts: "SQL result rows returned, not rows scanned", explain: "query plan only; physical visits not measured",
      sqlTiming: "Sum of execute-Promise wall times including scheduling, not SQLite CPU time or physical visits",
      cold: "fresh process/client and empty app caches; OS page cache not flushed" },
    shape: { profile: mode === "bench-realistic" ? "active-user baseline: 120 laps/week (~3 h at 90 s/lap), 12 sessions/week (~10 laps/session), 2-year history"
      : "archive stress only; not an active-user window cardinality", historyFrom: "2024-01-01T00:00:00.000Z", historyTo: DASHBOARD_FIXTURE_HISTORY_END,
      laps: lapCount, sessions: sessionCount, distribution }, gameCounts: fixture.gameCounts, identityCounts: fixture.identityCounts,
    aggregateAcceptance: { statements: baselineSql.statements, rowsReturned: baselineSql.rowsReturned,
      sourceQueries: baselineSql.sourceQueries, sourceRowsReturned: baselineSql.sourceRowsReturned, explain: baselineExplain },
    boundaryAcceptance, records,
  }, null, 2));
  for (const scope of scopes) {
    for (const periodScope of (scope === "recap" || scope === "boundary" ? [benchmarkPeriods[0]!] : benchmarkPeriods)) {
      const request = requestFor(scope, periodScope.request);
      const periodLabel = scope === "recap" ? (mode === "bench-realistic" ? "selected-10-lap-session" : "selected-500-lap-session")
        : scope === "boundary" ? "boundary-day" : periodScope.period;
      const scopeLabel = `${scope}/${periodLabel}/${request.gameId ?? "all"}/${request.from}`;
      const sourceCounts = scope === "recap" ? null : (await client.execute({
        sql: `SELECT COUNT(DISTINCT CASE WHEN s.created_at>=? AND s.created_at<? THEN s.id END) AS stored_sessions,
          COUNT(l.session_id) AS stored_laps,
          COUNT(DISTINCT CASE WHEN s.created_at>=? AND s.created_at<? AND s.ownership='mine' THEN s.id END) AS mine_sessions,
          SUM(CASE WHEN s.ownership='mine' AND l.session_id IS NOT NULL THEN 1 ELSE 0 END) AS mine_laps
          FROM sessions s LEFT JOIN laps l ON l.session_id=s.id AND l.created_at>=? AND l.created_at<?
          WHERE (s.created_at>=? AND s.created_at<? OR l.session_id IS NOT NULL)${request.gameId ? " AND s.game_id=?" : ""}`,
        args: [request.from, request.to, request.from, request.to, request.from, request.to, request.from, request.to,
          ...(request.gameId ? [request.gameId] : [])],
      })).rows[0];
      const workload = () => runScope(scope, request, fixture);
      const coldSamples = Array.from({ length: 30 }, () => coldProbe(scope, request, fixture));
      let warmed = await workload();
      for (let i = 1; i < 5; i++) warmed = await workload();
      if (scope === "recap") {
        assertEquivalent(warmed.value, await sourceRecapMetricOracle(fixture.latestRecapSessionId, fixture.latestRecapGameId), "recap");
      } else {
        assertDashboardMetrics(warmed.value as DashboardResponse, await sourceDashboardReference(request));
      }
      const idleRssBytes = process.memoryUsage().rss;
      let workloadPeakRssBytes = idleRssBytes;
      const workloadSampler = setInterval(() => { workloadPeakRssBytes = Math.max(workloadPeakRssBytes, process.memoryUsage().rss); }, 1);
      const latencies: number[] = [], statements: number[] = [], rows: number[] = [], payloads: number[] = [], memory: number[] = [];
      const sqlElapsedMs: number[] = [];
      const sourceQueries: Array<SqlMeasurement["sourceQueries"]> = [];
      const sourceRowsReturned: Array<SqlMeasurement["sourceRowsReturned"]> = [];
      for (let i = 0; i < 30; i++) {
        resetDashboardSqlMeasurement();
        const measured = await measureRequest(workload);
        const sql = dashboardSqlMeasurement();
        sqlElapsedMs.push(sql.queries.reduce((sum, query) => sum + query.elapsedMs, 0));
        latencies.push(measured.elapsedMs); statements.push(sql.statements); rows.push(sql.rowsReturned);
        payloads.push(measured.value.payloadBytes); memory.push(measured.rssDeltaBytes);
        sourceQueries.push(sql.sourceQueries); sourceRowsReturned.push(sql.sourceRowsReturned);
      }
      workloadPeakRssBytes = Math.max(workloadPeakRssBytes, process.memoryUsage().rss);
      clearInterval(workloadSampler);
      const workloadIncrementalRssBytes = Math.max(0, workloadPeakRssBytes - idleRssBytes);
      const p50 = percentile(latencies, 0.50), p95 = percentile(latencies, 0.95);
      const coldP50 = percentile(coldSamples.map((sample) => sample.elapsedMs), 0.50);
      const coldP95 = percentile(coldSamples.map((sample) => sample.elapsedMs), 0.95);
      const latencyBudget = scope === "recap" ? 200 : lapCount <= 100_000 ? 150 : 300;
      const coldBudget = lapCount <= 100_000 ? 750 : 1_500;
      const statementBudget = scope === "recap" ? 8 : 12;
      records.push({ scope, period: periodLabel, request, sourceCounts, warmups: 5, measuredRequests: 30, warmP50Ms: p50, warmP95Ms: p95,
        coldP50Ms: coldP50, coldP95Ms: coldP95,
        coldStatementCounts: coldSamples.map((sample) => sample.sql.statements), coldRowsReturned: coldSamples.map((sample) => sample.sql.rowsReturned),
        coldSourceQueries: coldSamples.map((sample) => sample.sql.sourceQueries), coldSourceRowsReturned: coldSamples.map((sample) => sample.sql.sourceRowsReturned),
        coldPayloadBytes: coldSamples.map((sample) => sample.payloadBytes), coldRssDeltaBytes: coldSamples.map((sample) => sample.rssDeltaBytes),
        statementCounts: statements, rowsReturned: rows, payloadBytes: payloads, perRequestRssDeltaBytes: memory,
        warmElapsedMs: latencies, coldElapsedMs: coldSamples.map((sample) => sample.elapsedMs),
        workloadIncrementalRssBytes, sourceQueries, sourceRowsReturned,
        sqlElapsedMs, coldSqlElapsedMs: coldSamples.map((sample) => sample.sql.queries.reduce((sum, query) => sum + query.elapsedMs, 0)),
      });
      try {
        assert(Math.max(...statements) <= statementBudget, `${scopeLabel}: warm statement budget exceeded`);
        assert(Math.max(...coldSamples.map((sample) => sample.sql.statements)) <= statementBudget,
          `${scopeLabel}: cold statement budget exceeded`);
        assert(p95 <= latencyBudget, `${scopeLabel}: warm p95 ${p95.toFixed(2)}ms exceeds ${latencyBudget}ms`);
        if (scope === "aggregate") assert(coldP95 <= coldBudget, `${scopeLabel}: cold p95 ${coldP95.toFixed(2)}ms exceeds ${coldBudget}ms`);
        assert(workloadIncrementalRssBytes <= 64 * 1024 * 1024,
          `${scopeLabel}: workload peak RSS ${workloadIncrementalRssBytes} bytes above idle exceeds 64 MiB`);
        if (scope !== "recap") {
          assert(Math.max(...payloads, ...coldSamples.map((sample) => sample.payloadBytes)) <= 128 * 1024,
            `${scopeLabel}: dashboard payload exceeds 128 KiB`);
        }
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
      await persistMeasurements("incomplete");
      group(`${distribution}/${lapCount}/${scopeLabel}`, () => bench("dashboard read", () => workload().then(() => undefined)));
    }
  }
  const mitata = failures.length ? null : await runMitataBenchmarks(`.omp/evidence/sqlite-dashboard/dashboard-read-model-${mode}.mitata.json`);
  await persistMeasurements(failures.length ? "failed" : "passed", mitata);
  if (failures.length) throw new Error(`${failures.length} benchmark scopes failed; full measurements written to ${evidencePath}: ${failures.join("; ")}`);
} else if (mode === "drain") {
  console.log(JSON.stringify({ published: await drainDashboardFixture() }));
} else {
  throw new Error(`Unknown dashboard read-model mode: ${mode}`);
}
dashboardServer.stop(true);
