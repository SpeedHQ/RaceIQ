import { expect, test } from "bun:test";
import { createStartupReadiness } from "../../src/runtime/startup-readiness";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("completion during initial generation inspection causes a fresh check and one launch", async () => {
  const inspecting = deferred<void>();
  const initial = deferred<boolean>();
  const launched = deferred<void>();
  let wake!: () => void;
  let inspections = 0;
  let launches = 0;
  let unsubscriptions = 0;
  const readiness = createStartupReadiness({
    subscribe(listener) { wake = listener; return () => { unsubscriptions++; }; },
    async inspect() { inspections++; if (inspections === 1) { inspecting.resolve(); return initial.promise; } return true; },
    launch() { launches++; launched.resolve(); },
    onBlocked() {},
  });
  try {
    await inspecting.promise;
    wake();
    wake();
    initial.resolve(false);
    await launched.promise;
    expect(inspections).toBe(2);
    expect(launches).toBe(1);
    expect(await readiness.getState()).toEqual({ state: "started" });
    wake();
    await readiness.stop();
    expect(unsubscriptions).toBe(1);
    expect(launches).toBe(1);
  } finally { initial.resolve(false); await readiness.stop(); }
});

test("stop wins late readiness and completion while awaiting owned inspection", async () => {
  const inspecting = deferred<void>();
  const initial = deferred<boolean>();
  let wake!: () => void;
  let launches = 0;
  let unsubscriptions = 0;
  const readiness = createStartupReadiness({
    subscribe(listener) { wake = listener; return () => { unsubscriptions++; }; },
    async inspect() { inspecting.resolve(); return initial.promise; },
    launch() { launches++; },
    onBlocked() {},
  });
  try {
    await inspecting.promise;
    let stopped = false;
    const stop = readiness.stop();
    void stop.then(() => { stopped = true; });
    expect(readiness.stop()).toBe(stop);
    await Promise.resolve();
    expect(stopped).toBe(false);
    wake();
    initial.resolve(true);
    await stop;
    wake();
    expect(launches).toBe(0);
    expect(unsubscriptions).toBe(1);
    expect(await readiness.getState()).toEqual({ state: "stopped" });
  } finally { initial.resolve(true); await readiness.stop(); }
});

test("inspection failure preserves actionable reason until a completion requests reinspection", async () => {
  const blocked = deferred<string>();
  const launched = deferred<void>();
  let wake!: () => void;
  let inspections = 0;
  const readiness = createStartupReadiness({
    subscribe(listener) { wake = listener; return () => {}; },
    async inspect() { if (++inspections === 1) throw new Error("EACCES reading organization journal"); return true; },
    launch() { launched.resolve(); },
    onBlocked(reason) { blocked.resolve(reason); },
  });
  try {
    expect(await blocked.promise).toBe("EACCES reading organization journal");
    expect(await readiness.getState()).toEqual({ state: "waiting", stage: "organization", reason: "EACCES reading organization journal" });
    expect(inspections).toBe(1);
    wake();
    await launched.promise;
    expect(inspections).toBe(2);
  } finally { await readiness.stop(); }
});
