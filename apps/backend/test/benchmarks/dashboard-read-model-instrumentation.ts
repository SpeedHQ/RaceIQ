import { client } from "@raceiq/backend-core/db/index";
import { setDashboardQueryObserver } from "@raceiq/backend-core/db/dashboard-queries";

export interface CapturedSql { sql: string; args: unknown; rowsReturned: number; elapsedMs: number }
export interface SqlMeasurement {
  statements: number;
  rowsReturned: number;
  sourceQueries: { laps: number; lapIndex: number; sessionIndex: number; daySummaries: number; timeBuckets: number; sectors: number; boundaryLapIndex: number };
  sourceRowsReturned: { laps: number; lapIndex: number; sessionIndex: number; daySummaries: number; timeBuckets: number; sectors: number; boundaryLapIndex: number };
  queries: CapturedSql[];
}
const emptySourceCounts = () => ({ laps: 0, lapIndex: 0, sessionIndex: 0, daySummaries: 0, timeBuckets: 0, sectors: 0, boundaryLapIndex: 0 });
const current: SqlMeasurement = { statements: 0, rowsReturned: 0, sourceQueries: emptySourceCounts(), sourceRowsReturned: emptySourceCounts(), queries: [] };
function observe(statement: string, bindings: unknown, resultRows: unknown[], elapsedMs: number): void {
  const rows = resultRows.length;
  current.statements++;
  current.rowsReturned += rows;
  current.queries.push({ sql: statement, args: bindings, rowsReturned: rows, elapsedMs });
  const sourceCounts = [
    [/\b(?:FROM|JOIN)\s+laps\b/i, "laps"],
    [/dashboard_lap_index/i, "lapIndex"],
    [/dashboard_session_index/i, "sessionIndex"],
    [/dashboard_(?:session_days|day_entities)/i, "daySummaries"],
    [/dashboard_(?:time_buckets|session_time_buckets)/i, "timeBuckets"],
    [/dashboard_session_sectors/i, "sectors"],
  ] as const;
  for (const [pattern, key] of sourceCounts) {
    if (!pattern.test(statement)) continue;
    current.sourceQueries[key]++;
    current.sourceRowsReturned[key] += rows;
  }
  if (/dashboard_lap_index/i.test(statement) && /created_at_ms\s*<\s*\?|created_at_ms\s*>=\s*\?/i.test(statement)) {
    current.sourceQueries.boundaryLapIndex++;
    current.sourceRowsReturned.boundaryLapIndex += rows;
  }
}
function getSql(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first === "string") return first;
  return first && typeof first === "object" && "sql" in first && typeof first.sql === "string" ? first.sql : "";
}
function getBindings(args: readonly unknown[]): unknown {
  const first = args[0];
  return first && typeof first === "object" && "args" in first ? first.args : args[1] ?? [];
}
function instrumentExecute(target: object): void {
  const original = Reflect.get(target, "execute");
  if (typeof original !== "function") throw new TypeError("libSQL execute method unavailable");
  Object.defineProperty(target, "execute", { configurable: true, value: new Proxy(original, {
    apply(method, receiver, args: unknown[]) {
      const statement = getSql(args), bindings = getBindings(args), start = performance.now();
      return Promise.resolve(Reflect.apply(method, receiver, args)).then((value: unknown) => {
        if (value && typeof value === "object" && "rows" in value && Array.isArray(value.rows)) {
          observe(statement, bindings, value.rows, performance.now() - start);
        }
        return value;
      });
    },
  }) });
}
export function installDashboardSqlInstrumentation(): void {
  setDashboardQueryObserver((statement, bindings, rows, elapsedMs) => observe(statement, bindings, rows, elapsedMs));
  const originalTransaction = Reflect.get(client, "transaction");
  if (typeof originalTransaction !== "function") throw new TypeError("libSQL transaction method unavailable");
  instrumentExecute(client);
  Object.defineProperty(client, "transaction", { configurable: true, value: new Proxy(originalTransaction, {
    apply(method, receiver, args: unknown[]) {
      return Promise.resolve(Reflect.apply(method, receiver, args)).then((tx: unknown) => {
        if (tx && typeof tx === "object") instrumentExecute(tx);
        return tx;
      });
    },
  }) });
}
export function resetDashboardSqlMeasurement(): void {
  current.statements = 0; current.rowsReturned = 0; current.queries.length = 0;
  Object.assign(current.sourceQueries, emptySourceCounts());
  Object.assign(current.sourceRowsReturned, emptySourceCounts());
}
export function dashboardSqlMeasurement(): SqlMeasurement {
  return { statements: current.statements, rowsReturned: current.rowsReturned, sourceQueries: { ...current.sourceQueries },
    sourceRowsReturned: { ...current.sourceRowsReturned }, queries: [...current.queries] };
}
