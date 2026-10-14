import type { Client, Transaction } from "@libsql/client";

/**
 * Queue client operations behind complete transaction lifetimes instead of
 * blocking SQLite on a write lock that this event loop must release.
 * While a transaction is open, use its handle, not the parent client.
 */
export function serializeSqliteClient(client: Client): Client {
  let pending = Promise.resolve();
  let transactionRelease: (() => void) | undefined;
  async function acquire(): Promise<() => void> {
    const previous = pending;
    let release!: () => void;
    pending = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    return release;
  }
  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const release = await acquire();
    try { return await operation(); }
    finally { release(); }
  }
  function leasedTransaction(transaction: Transaction, release: () => void): Transaction {
    const methods = new Map<PropertyKey, unknown>();
    const settle = () => {
      if (transactionRelease === release) transactionRelease = undefined;
      release();
    };
    return new Proxy(transaction, {
      get(target, key) {
        if (methods.has(key)) return methods.get(key);
        const value: unknown = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        const method = key === "close"
          ? () => { try { target.close(); } finally { settle(); } }
          : key === "commit" || key === "rollback"
            ? async () => { try { await Reflect.apply(value, target, []); } finally { if (target.closed) settle(); } }
            : value.bind(target);
        methods.set(key, method);
        return method;
      },
    });
  }
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(client, {
    get(target, key) {
      if (methods.has(key)) return methods.get(key);
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      const method = key === "transaction"
        ? async (...args: Parameters<Client["transaction"]>) => {
          const release = await acquire();
          try {
            const transaction = await target.transaction(...args);
            transactionRelease = release;
            return leasedTransaction(transaction, release);
          } catch (error) { release(); throw error; }
        }
        : key === "close"
          ? () => { try { target.close(); } finally { transactionRelease?.(); transactionRelease = undefined; } }
          : key === "execute" || key === "batch" || key === "executeMultiple" || key === "migrate" || key === "sync"
            ? (...args: unknown[]) => exclusive(async () => Reflect.apply(value, target, args))
            : value.bind(target);
      methods.set(key, method);
      return method;
    },
  });
}
