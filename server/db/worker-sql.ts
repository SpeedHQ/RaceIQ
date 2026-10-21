import type { Client, InArgs, InStatement, ResultSet, Transaction, TransactionMode } from "@libsql/client/sqlite3";

type WorkerSqlStatement = InStatement | [string, InArgs?];
export type WorkerSqlOperation =
  | { type: "execute"; statement: InStatement; transactionId?: number }
  | { type: "batch"; statements: WorkerSqlStatement[]; mode?: TransactionMode; transactionId?: number }
  | { type: "execute-multiple"; sql: string; transactionId?: number }
  | { type: "migrate"; statements: InStatement[] }
  | { type: "sync" }
  | { type: "begin"; mode?: TransactionMode }
  | { type: "commit" | "rollback" | "close"; transactionId: number };

export type WorkerSqlValue = undefined | null | boolean | number | string | bigint | ArrayBuffer | Uint8Array | WorkerSqlWireResult | WorkerSqlValue[] | { [key: string]: WorkerSqlValue };
export type WorkerSqlRequest = { type: "write-lease-sql"; leaseId: string; operationId: number; operation: WorkerSqlOperation };
export type WorkerSqlError = { name: string; message: string; code?: string | number; extendedCode?: string | number; rawCode?: string | number; cause?: WorkerSqlError | WorkerSqlValue };
export type WorkerSqlResponse =
  | { type: "write-lease-sql-result"; operationId: number; value: WorkerSqlValue }
  | { type: "write-lease-sql-error"; operationId: number; error: WorkerSqlError };
export type WorkerSqlSender = (operation: WorkerSqlOperation) => Promise<WorkerSqlResponse>;

type HostTransaction = { transaction: Transaction; ownerLease: string };
type LeaseState = { accepting: boolean; tail: Promise<void>; transactions: Set<number>; lastOperationId: number; pending: Map<number, Promise<WorkerSqlResponse>> };
const cloneValue = (value: unknown): WorkerSqlValue => {
  if (value === undefined || value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return value;
  if (value instanceof ArrayBuffer || value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return value.map(cloneValue);
  if (typeof value === "object") {
    const result: Record<string, WorkerSqlValue> = {};
    for (const [key, item] of Object.entries(value)) result[key] = cloneValue(item);
    return result;
  }
  return String(value);
};
const encodeError = (cause: unknown, depth = 0): WorkerSqlError => {
  if (cause instanceof Error) {
    const e = cause as Error & { code?: string | number; extendedCode?: string | number; rawCode?: string | number; cause?: unknown };
    const error: WorkerSqlError = { name: e.name, message: e.message };
    if (e.code !== undefined) error.code = e.code;
    if (e.extendedCode !== undefined) error.extendedCode = e.extendedCode;
    if (e.rawCode !== undefined) error.rawCode = e.rawCode;
    if (e.cause !== undefined && depth < 4) error.cause = e.cause instanceof Error ? encodeError(e.cause, depth + 1) : cloneValue(e.cause);
    return error;
  }
  return { name: "Error", message: String(cause) };
};
const decodeError = (data: WorkerSqlError): Error => {
  const error = new Error(data.message, data.cause === undefined ? undefined : { cause: data.cause });
  error.name = data.name;
  Object.assign(error, { code: data.code, extendedCode: data.extendedCode, rawCode: data.rawCode });
  return error;
};
type WorkerSqlWireResult = {
  columns: string[];
  columnTypes: string[];
  rows: WorkerSqlValue[][];
  rowsAffected: number;
  lastInsertRowid: bigint | undefined;
};
const encodeResult = (result: ResultSet): WorkerSqlWireResult => ({
  columns: result.columns,
  columnTypes: result.columnTypes,
  rows: result.rows.map((row) => Array.from({ length: row.length }, (_, index) => cloneValue(row[index]))),
  rowsAffected: result.rowsAffected,
  lastInsertRowid: result.lastInsertRowid,
});
const decodeResult = (value: WorkerSqlValue): ResultSet => {
  if (value === null || typeof value !== "object" || Array.isArray(value) || value instanceof ArrayBuffer || value instanceof Uint8Array) {
    throw new Error("Invalid worker SQL result payload");
  }
  const raw = value as WorkerSqlWireResult;
  const rows = raw.rows.map((values) => {
    const row: Record<string, unknown> = {};
    values.forEach((item, index) => Object.defineProperty(row, String(index), { value: item }));
    Object.defineProperty(row, "length", { value: values.length });
    raw.columns.forEach((column, index) => {
      if (!Object.hasOwn(row, column)) Object.defineProperty(row, column, { value: values[index], writable: true, enumerable: true, configurable: true });
    });
    return row;
  });
  return {
    columns: raw.columns,
    columnTypes: raw.columnTypes,
    rows,
    rowsAffected: raw.rowsAffected,
    lastInsertRowid: raw.lastInsertRowid,
    toJSON: () => ({
      columns: raw.columns,
      columnTypes: raw.columnTypes,
      rows: raw.rows.map((values) => values.map((item) => {
        if (typeof item === "bigint") return item.toString();
        if (item instanceof ArrayBuffer) return Buffer.from(item).toString("base64");
        if (item instanceof Uint8Array) return Buffer.from(item.buffer, item.byteOffset, item.byteLength).toString("base64");
        return item;
      })),
      rowsAffected: raw.rowsAffected,
      lastInsertRowid: raw.lastInsertRowid?.toString() ?? null,
    }),
  } as unknown as ResultSet;
};

export function createWorkerSqlHost(client: Client) {
  const leases = new Map<string, LeaseState>();
  const transactions = new Map<number, HostTransaction>();
  let nextTransactionId = 0;
  let closed = false;
  let hostClose: Promise<void> | null = null;
  const execute = async (leaseId: string, operation: WorkerSqlOperation): Promise<WorkerSqlValue> => {
    if (operation.type === "migrate") return (await client.migrate(operation.statements)).map(encodeResult);
    if (operation.type === "sync") return cloneValue(await client.sync());
    if (operation.type === "begin") {
      const transaction = await client.transaction(operation.mode);
      const transactionId = nextTransactionId++;
      transactions.set(transactionId, { transaction, ownerLease: leaseId });
      leases.get(leaseId)!.transactions.add(transactionId);
      return transactionId;
    }
    if ("transactionId" in operation && operation.transactionId !== undefined) {
      const owned = transactions.get(operation.transactionId);
      if (!owned || owned.ownerLease !== leaseId) throw new Error("Unknown or foreign worker SQL transaction");
      const tx = owned.transaction;
      switch (operation.type) {
        case "execute": return encodeResult(await tx.execute(operation.statement));
        case "batch": {
          const statements = operation.statements.map((statement) => Array.isArray(statement) ? { sql: statement[0], args: statement[1] } : statement);
          return (await tx.batch(statements)).map(encodeResult);
        }
        case "execute-multiple": return cloneValue(await tx.executeMultiple(operation.sql));
      }
    }
    switch (operation.type) {
      case "execute": return encodeResult(await client.execute(operation.statement));
      case "batch": return (await client.batch(operation.statements, operation.mode)).map(encodeResult);
      case "execute-multiple": return cloneValue(await client.executeMultiple(operation.sql));
      case "commit": case "rollback": case "close": {
        const owned = transactions.get(operation.transactionId);
        if (!owned || owned.ownerLease !== leaseId) throw new Error("Unknown or foreign worker SQL transaction");
        try {
          if (operation.type === "commit") await owned.transaction.commit();
          else if (operation.type === "rollback") await owned.transaction.rollback();
          else await owned.transaction.close();
        } catch (error) {
          if (owned.transaction.closed) {
            transactions.delete(operation.transactionId);
            leases.get(leaseId)?.transactions.delete(operation.transactionId);
          }
          throw error;
        }
        if (!owned.transaction.closed) throw new Error("Worker SQL transaction operation left native transaction open");
        transactions.delete(operation.transactionId);
        leases.get(leaseId)?.transactions.delete(operation.transactionId);
        return null;
      }
    }
  };
  const closingLeases = new Map<string, Promise<void>>();
  const closeLease = (leaseId: string): Promise<void> => {
    const closing = closingLeases.get(leaseId);
    if (closing) return closing;
    const state = leases.get(leaseId);
    if (!state) return Promise.resolve();
    state.accepting = false;
    const cleanup = (async () => {
      await state.tail;
      let cleanupError: unknown;
      for (const id of [...state.transactions]) {
        const item = transactions.get(id);
        if (!item) continue;
        let rollbackError: unknown;
        try { await item.transaction.rollback(); } catch (error) { rollbackError = error; }
        let closeError: unknown;
        try { await item.transaction.close(); } catch (error) { closeError = error; }
        if (rollbackError !== undefined) console.error("Worker SQL rollback failed during lease cleanup", rollbackError);
        if (item.transaction.closed) {
          if (closeError !== undefined) console.error("Worker SQL close failed after transaction settled", closeError);
          transactions.delete(id);
          state.transactions.delete(id);
        } else {
          cleanupError ??= closeError ?? new Error("Worker SQL transaction remains open after close");
        }
      }
      if (state.transactions.size === 0) leases.delete(leaseId);
      closingLeases.delete(leaseId);
      if (cleanupError !== undefined) throw cleanupError;
    })();
    closingLeases.set(leaseId, cleanup);
    return cleanup;
  };
  return {
    openLease(leaseId: string): void {
      if (closed) throw new Error("Worker SQL host is closed");
      if (leases.has(leaseId)) throw new Error("Worker SQL lease already open");
      leases.set(leaseId, { accepting: true, tail: Promise.resolve(), transactions: new Set(), lastOperationId: -1, pending: new Map() });
    },
    receive(request: WorkerSqlRequest): Promise<WorkerSqlResponse> {
      const state = leases.get(request.leaseId);
      if (!state) return Promise.resolve({ type: "write-lease-sql-error", operationId: request.operationId, error: encodeError(new Error("Worker SQL lease is closed")) });
      if (!Number.isSafeInteger(request.operationId) || request.operationId < 0) return Promise.resolve({ type: "write-lease-sql-error", operationId: request.operationId, error: encodeError(new Error("Invalid worker SQL operation ID")) });
      const pending = state.pending.get(request.operationId);
      if (pending) return pending;
      if (!state.accepting || closed) return Promise.resolve({ type: "write-lease-sql-error", operationId: request.operationId, error: encodeError(new Error("Worker SQL lease is closed")) });
      if (request.operationId <= state.lastOperationId) return Promise.resolve({ type: "write-lease-sql-error", operationId: request.operationId, error: encodeError(new Error("Stale worker SQL operation ID")) });
      state.lastOperationId = request.operationId;
      const { promise: result, resolve } = Promise.withResolvers<WorkerSqlResponse>();
      state.pending.set(request.operationId, result);
      const run = state.tail.then(async () => {
        if (!state.accepting) {
          resolve({ type: "write-lease-sql-error", operationId: request.operationId, error: encodeError(new Error("Worker SQL lease is closing")) });
          return;
        }
        try { resolve({ type: "write-lease-sql-result", operationId: request.operationId, value: await execute(request.leaseId, request.operation) }); }
        catch (error) { resolve({ type: "write-lease-sql-error", operationId: request.operationId, error: encodeError(error) }); }
      });
      state.tail = run.then(() => undefined, () => undefined);
      void run.then(() => state.pending.delete(request.operationId));
      return result;
    },
    closeLease,
    close(): Promise<void> {
      if (hostClose) return hostClose;
      closed = true;
      const closing = (async () => {
        let cleanupError: unknown;
        for (const leaseId of [...leases.keys()]) {
          try { await closeLease(leaseId); } catch (error) { cleanupError ??= error; }
        }
        if (cleanupError !== undefined) throw cleanupError;
      })();
      hostClose = closing;
      void closing.catch(() => {
        if (hostClose === closing) hostClose = null;
      });
      return closing;
    },
  };
}

export function createWorkerSqlClient(getSender: () => WorkerSqlSender): Client {
  let closed = false;
  const send = async <T>(operation: WorkerSqlOperation, sender?: WorkerSqlSender): Promise<T> => {
    if (closed) throw new Error("Client is closed");
    const response = await (sender ?? getSender())(operation);
    if (response.type === "write-lease-sql-error") throw decodeError(response.error);
    if (operation.type === "execute") return decodeResult(response.value) as T;
    if (operation.type === "batch" || operation.type === "migrate") return (response.value as WorkerSqlValue[]).map(decodeResult) as T;
    return response.value as T;
  };
  const createTransaction = (id: number, sender: WorkerSqlSender): Transaction => {
    let done = false;
    const invoke = <T>(operation: WorkerSqlOperation): Promise<T> => {
      if (done) return Promise.reject(new Error("Transaction is closed"));
      return send<T>(operation, sender);
    };
    return {
      execute: (statement: InStatement | string, args?: InArgs) => invoke<ResultSet>({ type: "execute", statement: typeof statement === "string" && args !== undefined ? { sql: statement, args } : statement, transactionId: id }),
      batch: (statements: WorkerSqlStatement[], mode?: TransactionMode) => invoke<ResultSet[]>({ type: "batch", statements, mode, transactionId: id }),
      executeMultiple: (sql: string) => invoke<void>({ type: "execute-multiple", sql, transactionId: id }),
      commit: async () => { await invoke<void>({ type: "commit", transactionId: id }); done = true; },
      rollback: async () => { await invoke<void>({ type: "rollback", transactionId: id }); done = true; },
      close: async () => { if (!done) { await invoke<void>({ type: "close", transactionId: id }); done = true; } },
      get closed() { return done; },
      protocol: "file",
    } as unknown as Transaction;
  };
  const base = {
    execute: (statement: InStatement | string, args?: InArgs) => send<ResultSet>({ type: "execute", statement: typeof statement === "string" && args !== undefined ? { sql: statement, args } : statement }),
    batch: (statements: WorkerSqlStatement[], mode?: TransactionMode) => send<ResultSet[]>({ type: "batch", statements, mode }),
    executeMultiple: (sql: string) => send<void>({ type: "execute-multiple", sql }),
    migrate: (statements: InStatement[]) => send<ResultSet[]>({ type: "migrate", statements }),
    sync: () => send<WorkerSqlValue>({ type: "sync" }),
    transaction: async (mode?: TransactionMode) => {
      if (closed) throw new Error("Client is closed");
      const sender = getSender();
      return createTransaction(await send<number>({ type: "begin", mode }, sender), sender);
    },
    close: () => { closed = true; },
    reconnect: () => { closed = false; },
    get closed() { return closed; },
    protocol: "file",
  };
  return base as unknown as Client;
}
