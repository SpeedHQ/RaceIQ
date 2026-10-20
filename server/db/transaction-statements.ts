import type { InValue, ResultSet, Transaction } from "@libsql/client";

/** Execute a Drizzle-built statement on the caller's existing native transaction. */
export function executeTransactionStatement(
  transaction: Transaction,
  query: { toSQL(): { sql: string; params: unknown[] } },
): Promise<ResultSet> {
  const { sql, params } = query.toSQL();
  // Drizzle has already encoded concrete column values into native driver bindings.
  return transaction.execute({ sql, args: params as InValue[] });
}
