import { client } from "@raceiq/backend-core/db/index";

export interface CapturedSql { sql: string; args: unknown; rowsReturned: number }
export interface SqlMeasurement {
  statements: number;
  rowsReturned: number;
  sourceQueries: { laps: number; lapIndex: number; sessionIndex: number; daySummaries: number; timeBuckets: number; sectors: number; boundaryLapIndex: number };
  sourceRowsReturned: { laps: number; lapIndex: number; sessionIndex: number; daySummaries: number; timeBuckets: number; sectors: number; boundaryLapIndex: number };
  queries: CapturedSql[];
}
const emptySourceCounts = () => ({ laps: 0, lapIndex: 0, sessionIndex: 0, daySummaries: 0, timeBuckets: 0, sectors: 0, boundaryLapIndex: 0 });
const current: SqlMeasurement = { statements: 0, rowsReturned: 0, sourceQueries: emptySourceCounts(), sourceRowsReturned: emptySourceCounts(), queries: [] };
function getSql(args: readonly unknown[]): string {
  const first = args[0];
  if (typeof first === "string") return first;
  if (!first || typeof first !== "object" || !("sql" in first)) return "";
  const statement = first.sql;
  return typeof statement === "string" ? statement : "";
}
function getBindings(args: readonly unknown[]): unknown {
  const first = args[0];
  if (first && typeof first === "object" && "args" in first) return first.args;
  return args[1] ?? [];
}
function rowsCount(result: unknown): number {
  if (!result || typeof result !== "object" || !("rows" in result) || !Array.isArray(result.rows)) return 0;
  return result.rows.length;
}
function observe(statement: string, bindings: unknown, result: unknown): void {
  const rows = rowsCount(result);
  current.statements++;
  current.rowsReturned += rows;
  current.queries.push({ sql: statement, args: bindings, rowsReturned: rows });
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
function instrumentExecute(target: object): void {
  const original = Reflect.get(target, "execute");
  if (typeof original !== "function") throw new TypeError("libSQL execute method unavailable");
  Object.defineProperty(target, "execute", { configurable: true, value: new Proxy(original, {
    apply(method, receiver, args: unknown[]) {
      const statement = getSql(args), bindings = getBindings(args);
      const result = Reflect.apply(method, receiver, args);
      return Promise.resolve(result).then((value: unknown) => { observe(statement, bindings, value); return value; });
    },
  }) });
}
export function installDashboardSqlInstrumentation(): void {
  const originalTransaction = Reflect.get(client, "transaction");
  if (typeof originalTransaction !== "function") throw new TypeError("libSQL transaction method unavailable");
  instrumentExecute(client);
  Object.defineProperty(client, "transaction", { configurable: true, value: new Proxy(originalTransaction, {
    apply(method, receiver, args: unknown[]) {
      const transaction = Reflect.apply(method, receiver, args);
      return Promise.resolve(transaction).then((tx: unknown) => { if (tx && typeof tx === "object") instrumentExecute(tx); return tx; });
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
