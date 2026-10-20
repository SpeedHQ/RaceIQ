import { expect, test } from "bun:test";
import { createStartupStageRunner, defineStartupStage } from "../../src/runtime/startup-stage-runner";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

for (const status of ["pending", "running", "partial", "failed", "interrupted"] as const) {
  test(`${status} prerequisite blocks every startup successor`, async () => {
    const called: string[] = [];
    const stages = [
      defineStartupStage({ id: "first", name: "first", run: async () => { called.push("first"); return { status }; }, isComplete: (result) => String(result.status) === "complete", blockedReason: (result) => result.status }),
      defineStartupStage({ id: "next", name: "next", run: async () => { called.push("next"); return 0; }, isComplete: (count) => count === 0, blockedReason: () => "pending repair" }),
    ];
    const runner = createStartupStageRunner(stages, () => {});
    try {
      expect(await runner.run()).toBe(false);
      expect(called).toEqual(["first"]);
      expect(await runner.getState()).toEqual({ state: "waiting", stage: "first", reason: status });
    } finally { await runner.stop(); }
  });
}

test("duplicate admissions coalesce; stop settles active repair before suppressing successors", async () => {
  const entered = deferred<void>();
  const release = deferred<number>();
  const called: string[] = [];
  const runner = createStartupStageRunner([
    defineStartupStage({ id: "active", name: "active", run: async () => { entered.resolve(); return release.promise; }, isComplete: (count) => count === 0, blockedReason: () => "repairs remain", onComplete: () => { called.push("complete"); } }),
    defineStartupStage({ id: "next", name: "next", run: async () => { called.push("next"); return 0; }, isComplete: (count) => count === 0, blockedReason: () => "pending" }),
  ], () => {});
  try {
    const admitted = runner.run();
    await entered.promise;
    expect(runner.run()).toBe(admitted);
    let stopped = false;
    const stop = runner.stop();
    void stop.then(() => { stopped = true; });
    expect(runner.stop()).toBe(stop);
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve(0);
    expect(await admitted).toBe(false);
    await stop;
    expect(called).toEqual([]);
    expect(await runner.getState()).toEqual({ state: "stopped" });
  } finally { release.resolve(0); await runner.stop(); }
});

for (const failureAt of ["repair", "entry", "completion"] as const) {
  test(`thrown ${failureAt} failure retains its exact stage and disposes on stop`, async () => {
    const failures: Array<{ stage: string; reason: string; kind: string }> = [];
    const called: string[] = [];
    const runner = createStartupStageRunner([
      defineStartupStage({
        id: "historical", name: "Historical session reconciliation",
        run: async () => { called.push("repair"); if (failureAt === "repair") throw new Error("capture read failed"); return 0; },
        isComplete: (count) => count === 0,
        blockedReason: () => "repairs remain",
        onComplete: () => { if (failureAt === "completion") throw new Error("capture read failed"); },
      }),
      defineStartupStage({ id: "dashboard", name: "dashboard", run: async () => { called.push("dashboard"); return 0; }, isComplete: (count) => count === 0, blockedReason: () => "pending" }),
    ], (stage, reason, kind) => { failures.push({ stage: stage.id, reason, kind }); }, async () => { if (failureAt === "entry") throw new Error("capture read failed"); });
    try {
      expect(await runner.run()).toBe(false);
      expect(failures).toEqual([{ stage: "historical", reason: "capture read failed", kind: "failed" }]);
      expect(await runner.getState()).toEqual({ state: "failed", stage: "historical", reason: "capture read failed" });
      expect(called).not.toContain("dashboard");
      if (failureAt === "entry") expect(called).toEqual([]);
    } finally { await runner.stop(); }
    expect(await runner.getState()).toEqual({ state: "stopped" });
  });
}

test("stop at repair-entry barrier never starts the repair", async () => {
  const entered = deferred<void>();
  const release = deferred<void>();
  let repairs = 0;
  const runner = createStartupStageRunner([
    defineStartupStage({ id: "historical", name: "historical", run: async () => { repairs++; return 0; }, isComplete: (count) => count === 0, blockedReason: () => "pending" }),
  ], () => {}, async () => { entered.resolve(); await release.promise; });
  try {
    const running = runner.run();
    await entered.promise;
    const stop = runner.stop();
    release.resolve();
    expect(await running).toBe(false);
    await stop;
    expect(repairs).toBe(0);
  } finally { release.resolve(); await runner.stop(); }
});

test("failure settling during stop still drains and cannot launch the next stage", async () => {
  const entered = deferred<void>();
  const release = deferred<number>();
  let successors = 0;
  const runner = createStartupStageRunner([
    defineStartupStage({ id: "historical", name: "historical", run: async () => { entered.resolve(); return release.promise; }, isComplete: (count) => count === 0, blockedReason: () => "pending" }),
    defineStartupStage({ id: "dashboard", name: "dashboard", run: async () => { successors++; return 0; }, isComplete: (count) => count === 0, blockedReason: () => "pending" }),
  ], () => {});
  try {
    const running = runner.run();
    await entered.promise;
    const stop = runner.stop();
    release.reject(new Error("SQL statement rejected during shutdown"));
    expect(await running).toBe(false);
    await stop;
    expect(successors).toBe(0);
    expect(await runner.getState()).toEqual({ state: "stopped" });
  } finally { release.resolve(0); await runner.stop(); }
});
