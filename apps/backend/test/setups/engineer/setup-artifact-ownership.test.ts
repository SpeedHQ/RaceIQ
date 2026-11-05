import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { RequestContext } from "@mastra/core/request-context";
import type { ToolExecutionContext } from "@mastra/core/tools";
import { db } from "@raceiq/backend-core/db/index";
import { experimentActions, experiments, experimentVersions } from "@raceiq/backend-core/db/schema";
import { createExperiment, getExperiment, setSessionHead } from "@raceiq/backend-core/db/experiment-queries";
import { createExperimentVersion, listExperimentVersions } from "@raceiq/backend-core/db/experiment-version-queries";
import { CHAT_TURN_MESSAGES_KEY } from "@raceiq/backend-core/ai/chat-message-context";
import { writeSetupFile } from "@raceiq/backend-core/ai/tune-writer";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { ROOT_DIR } from "@raceiq/backend-core/runtime/config/paths";
import { carSetupToKnobValues } from "@raceiq/game-ac-evo/carsetup";
import { parseCarSetup } from "@raceiq/game-ac-evo/carsetup-wire";
import * as setupIo from "../../../src/setups/io";
import { setupEngineerTools } from "../../../src/mastra/tools/setup-engineer";
import { EXPERIMENT_CHAT_BRANCH_CONTEXT_KEY } from "../../../src/mastra/tools/setup-engineer-request-context";
import type { ExperimentChatBranchContext } from "../../../src/experiments/chat-branch-context";

function setup() {
  return {
    basicSetup: { tyres: { tyrePressure: [26, 26, 26, 26] } },
    advancedSetup: {
      mechanicalBalance: { aRBFront: 5, aRBRear: 5, brakeBias: 55 },
      aeroBalance: { splitter: 3, rearWing: 4, rideHeight: [65, 65, 75, 75] },
      dampers: { bumpSlow: [8, 8, 8, 8], reboundSlow: [8, 8, 8, 8] },
      drivetrain: { preload: 40 },
    },
  };
}

test("manual setup save preserves a competing file created at the write boundary", () => {
  const dir = fs.mkdtempSync(resolve(tmpdir(), "raceiq-artifact-owner-"));
  const source = resolve(dir, "base.json");
  const collision = resolve(dir, "owned.json");
  const userBytes = "pre-existing user setup";
  const realWrite = fs.writeFileSync;
  realWrite(source, JSON.stringify(setup()));
  const write = spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
    if (file === collision && !fs.existsSync(collision)) realWrite(collision, userBytes);
    return realWrite(file, data, options);
  });
  try {
    const written = writeSetupFile(dir, source, setup(), "owned");
    expect(fs.readFileSync(collision, "utf8")).toBe(userBytes);
    expect(written.path).not.toBe(collision);
    expect(JSON.parse(fs.readFileSync(written.path, "utf8"))).toEqual(setup());
    expect(JSON.parse(fs.readFileSync(source, "utf8"))).toEqual(setup());
  } finally {
    write.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("binary setup save preserves a competing file created at the write boundary", () => {
  const dir = fs.mkdtempSync(resolve(tmpdir(), "raceiq-binary-owner-"));
  const source = resolve(dir, "base.carsetup");
  const collision = resolve(dir, "owned.carsetup");
  const bytes = fs.readFileSync(resolve(ROOT_DIR, "test/artifacts/carsetup/Default-12312.carsetup"));
  const knobs = carSetupToKnobValues(parseCarSetup(bytes)!);
  const userBytes = "pre-existing user binary setup";
  const realWrite = fs.writeFileSync;
  realWrite(source, bytes);
  const write = spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
    if (file === collision && !fs.existsSync(collision)) realWrite(collision, userBytes);
    return realWrite(file, data, options);
  });
  try {
    const written = setupIo.writeAppliedSetup("ac-evo", { baseDir: dir, realPath: source, setup: knobs, stem: "owned" });
    expect(fs.readFileSync(collision, "utf8")).toBe(userBytes);
    expect(written.setupPath).not.toBeNull();
    expect(written.setupPath).not.toBe(collision);
    expect(fs.readFileSync(written.setupPath!)).toEqual(bytes);
    expect(fs.readFileSync(source)).toEqual(bytes);
  } finally {
    write.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("checkout after physical apply write removes only its artifact and creates no version or action", async () => {
  initGameAdapters();
  const dir = fs.mkdtempSync(resolve(tmpdir(), "raceiq-stale-artifact-"));
  const source = resolve(dir, "base.json");
  const sourceBytes = JSON.stringify(setup());
  fs.writeFileSync(source, sourceBytes);
  const sid = await createExperiment({ gameId: "acc", name: "artifact-race" });
  const root = await createExperimentVersion({ experimentId: sid, version: 1, label: "v1", parentVersionId: null, setupPath: source });
  const sibling = await createExperimentVersion({ experimentId: sid, version: 2, label: "v2", parentVersionId: null, setupPath: source });
  await db.update(experiments).set({ headVersionId: root }).where(eq(experiments.id, sid)).run();
  const session = (await getExperiment(sid))!;
  const versions = await listExperimentVersions(sid);
  const activeVersion = versions.find((version) => version.id === root)!;
  const branch: ExperimentChatBranchContext = {
    sessionId: sid, headVersionId: root, session, versions, activeVersion, laps: [], lapIds: [],
    setupContext: { ok: true, gameId: "acc", session, tests: versions, activeTest: activeVersion, baseDir: dir, realPath: source, setup: setup() },
  };
  const context = new RequestContext();
  context.set("gameId", "acc");
  context.set("sessionId", sid);
  context.set(EXPERIMENT_CHAT_BRANCH_CONTEXT_KEY, branch);
  const realWrite = setupIo.writeAppliedSetup;
  let artifact: string | null = null;
  let physicalWriteObserved = false;
  const preserved = resolve(dir, "user.json");
  fs.writeFileSync(preserved, "user-owned file");
  const write = spyOn(setupIo, "writeAppliedSetup").mockImplementation((gameId, params) => {
    const result = realWrite(gameId, params);
    artifact = result.setupPath;
    physicalWriteObserved = artifact !== null && fs.existsSync(artifact);
    db.update(experiments).set({ headVersionId: sibling }).where(eq(experiments.id, sid)).run();
    return result;
  });
  try {
    const result = await setupEngineerTools.applyChangesTool.execute!({
      driverConfirmed: true,
      goal: "confirmed front bar increase",
      changes: [{ component: "Front Anti-Roll Bar", direction: "increase", magnitude: "small", reason: "confirmed" }],
    }, { requestContext: context } as ToolExecutionContext);
    expect(physicalWriteObserved).toBe(true);
    expect(result as unknown).toMatchObject({ ok: false });
    expect(fs.existsSync(artifact!)).toBe(false);
    expect(fs.readFileSync(source, "utf8")).toBe(sourceBytes);
    expect(fs.readFileSync(preserved, "utf8")).toBe("user-owned file");
    expect((await getExperiment(sid))?.headVersionId).toBe(sibling);
    expect((await listExperimentVersions(sid)).map((version) => version.id)).toEqual(versions.map((version) => version.id));
    expect(await db.select().from(experimentActions).where(eq(experimentActions.experimentId, sid)).all()).toEqual([]);
  } finally {
    write.mockRestore();
    await db.delete(experimentActions).where(eq(experimentActions.experimentId, sid)).run();
    await db.delete(experimentVersions).where(eq(experimentVersions.experimentId, sid)).run();
    await db.delete(experiments).where(eq(experiments.id, sid)).run();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("same-turn confirmed applies fork from captured evidence while CAS follows owned head", async () => {
  initGameAdapters();
  const dir = fs.mkdtempSync(resolve(tmpdir(), "raceiq-turn-mutations-"));
  const snapshot = { frontWing: 20, rearWing: 20 };
  const sid = await createExperiment({ gameId: "f1-2025", name: "turn-mutations" });
  const root = await createExperimentVersion({ experimentId: sid, version: 1, label: "v1", parentVersionId: null, setupSnapshot: JSON.stringify(snapshot) });
  const concurrent = await createExperimentVersion({ experimentId: sid, version: 2, label: "concurrent", parentVersionId: null, setupSnapshot: JSON.stringify(snapshot) });
  await db.update(experiments).set({ headVersionId: root }).where(eq(experiments.id, sid)).run();
  const session = (await getExperiment(sid))!;
  const versions = await listExperimentVersions(sid);
  const activeVersion = versions.find((version) => version.id === root)!;
  const branch: ExperimentChatBranchContext = {
    sessionId: sid, headVersionId: root, session, versions, activeVersion, laps: [], lapIds: [12345],
    setupContext: { ok: true, gameId: "f1-2025", session, tests: versions, activeTest: activeVersion, baseDir: dir, realPath: null, setup: snapshot },
  };
  const context = new RequestContext();
  context.set("gameId", "f1-2025");
  context.set("sessionId", sid);
  context.set(EXPERIMENT_CHAT_BRANCH_CONTEXT_KEY, branch);
  const apply = (direction: "increase" | "decrease") => setupEngineerTools.applyChangesTool.execute!({
    driverConfirmed: true,
    target: "v1",
    goal: "confirmed setup variant",
    changes: [{ component: "Front Wing", direction, magnitude: "small", reason: "confirmed" }],
  }, { requestContext: context } as ToolExecutionContext);
  try {
    const skipped = await setupEngineerTools.applyChangesTool.execute!({
      driverConfirmed: true,
      target: "v1",
      goal: "no-op attempt",
      changes: [{ component: "not-a-real-component", direction: "increase", magnitude: "small", reason: "skip" }],
    }, { requestContext: context } as ToolExecutionContext);
    expect(skipped).toMatchObject({ ok: false });
    expect((await getExperiment(sid))!.headVersionId).toBe(root);
    const first = await apply("increase");
    const second = await apply("decrease");
    expect(first).toMatchObject({ ok: true });
    expect(second).toMatchObject({ ok: true });
    const children = (await listExperimentVersions(sid)).filter((version) => version.parentVersionId === root);
    expect(children).toHaveLength(2);
    expect(new Set(children.map((version) => version.label)).size).toBe(2);
    const ownedHead = (await getExperiment(sid))!.headVersionId;

    await db.update(experiments).set({ headVersionId: concurrent }).where(eq(experiments.id, sid)).run();
    const refused = await apply("increase");
    expect(refused).toMatchObject({ ok: false });
    expect((await getExperiment(sid))!.headVersionId).toBe(concurrent);
    expect(branch.headVersionId).toBe(root);
    expect(branch.lapIds).toEqual([12345]);
    expect(ownedHead).not.toBe(root);
  } finally {
    await db.delete(experimentActions).where(eq(experimentActions.experimentId, sid)).run();
    await db.delete(experimentVersions).where(eq(experimentVersions.experimentId, sid)).run();
    await db.delete(experiments).where(eq(experiments.id, sid)).run();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("replayed confirmed chat message returns committed setup result without creating a second version", async () => {
  initGameAdapters();
  const sid = await createExperiment({ gameId: "f1-2025", name: "chat-action-idempotency" });
  const snapshot = { frontWing: 20, rearWing: 20 };
  const root = await createExperimentVersion({ experimentId: sid, version: 1, label: "v1", kind: "setup", setupSnapshot: JSON.stringify(snapshot) });
  await setSessionHead(sid, root);
  const messages = [
    { role: "assistant", parts: [{ type: "text", text: "I recommend a small increase to Front Wing for more front grip. Should I apply it?" }] },
    { id: "confirmation-message-1", role: "user", parts: [{ type: "text", text: "Yes, apply that." }] },
  ];
  const contextAtHead = async () => {
    const session = (await getExperiment(sid))!;
    const versions = await listExperimentVersions(sid);
    const activeVersion = versions.find((version) => version.id === session.headVersionId)!;
    const branch: ExperimentChatBranchContext = {
      sessionId: sid, headVersionId: session.headVersionId, session, versions, activeVersion,
      laps: [], lapIds: [],
      setupContext: {
        ok: true, gameId: "f1-2025", session, tests: versions, activeTest: activeVersion,
        baseDir: null, realPath: null,
        setup: JSON.parse(activeVersion.setupSnapshot!) as typeof snapshot,
      },
    };
    const requestContext = new RequestContext();
    requestContext.set("gameId", "f1-2025");
    requestContext.set("sessionId", sid);
    requestContext.set(EXPERIMENT_CHAT_BRANCH_CONTEXT_KEY, branch);
    requestContext.set(CHAT_TURN_MESSAGES_KEY, messages);
    return { requestContext };
  };
  const input = {
    driverConfirmed: true,
    goal: "more front grip",
    changes: [{ component: "Front Wing", direction: "increase" as const, magnitude: "small" as const, reason: "confirmed front grip change" }],
  };
  try {
    const first = await setupEngineerTools.applyChangesTool.execute!(input, await contextAtHead() as ToolExecutionContext);
    const replay = await setupEngineerTools.applyChangesTool.execute!(input, await contextAtHead() as ToolExecutionContext);
    expect(replay).toEqual(first);
    expect(await listExperimentVersions(sid)).toHaveLength(2);
    expect((await getExperiment(sid))?.headVersionId).not.toBe(root);
    const actions = await db.select().from(experimentActions).where(eq(experimentActions.experimentId, sid)).all();
    expect(actions).toHaveLength(1);
    expect(JSON.parse(actions[0]!.inversePayload!)).toMatchObject({
      chatMutationReplay: {
        userMessageId: "confirmation-message-1",
        toolName: "apply_changes",
        result: { ok: true, version: 2, applied: [{ component: "Front Wing", from: 20, to: 21 }] },
      },
    });
  } finally {
    await db.delete(experimentActions).where(eq(experimentActions.experimentId, sid)).run();
    await db.delete(experimentVersions).where(eq(experimentVersions.experimentId, sid)).run();
    await db.delete(experiments).where(eq(experiments.id, sid)).run();
  }
});
