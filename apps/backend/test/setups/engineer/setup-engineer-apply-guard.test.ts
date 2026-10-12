/**
 * Setup Engineer mutation guards and on-demand lap-issue analysis.
 *
 * This file imports the real singleton tools. Gated dispatchers isolate
 * DB/fs/memory writes while the deterministic engine and worker analysis stay
 * real. Unknown components must not write a setup or create a phantom version.
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import type { TelemetryPacket } from "@raceiq/shared/telemetry/types";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { detectCorners } from "@raceiq/backend-core/lap-analysis/corners";
import { telemetryToSymptoms } from "@raceiq/backend-core/ai/tune-symptoms";
import { symptomsToIssues } from "@raceiq/backend-core/ai/tune-issues";
import { analyzeLapIssues } from "@raceiq/backend-core/experiments/lap-issues";
import { RequestContext } from "@mastra/core/request-context";
import { setupEngineerTools } from "../../../src/mastra/tools/setup-engineer";

// `mock.module` is PROCESS-global in Bun and cannot be undone: re-mocking an
// already-mocked path is a no-op, so an `afterAll` "restore" achieves nothing
// and every later test file in the run would import these stubs (which is how
// the tuning/chat suites started seeing `createExperimentVersion() === 999`).
//
// So the stubs are *gated dispatchers*: each one delegates to the real export
// unless `stubsActive` is set, and only this file's tests set it. Real
// namespaces are captured by static import, which evaluates before any
// `mock.module` call below.
import * as RealSetupIo from "../../../src/setups/io";
import * as RealTestQueries from "@raceiq/backend-core/db/experiment-version-queries";
import * as RealSessionQueries from "@raceiq/backend-core/db/experiment-queries";
import * as RealChatAgent from "@raceiq/backend-core/ai/chat-agent";
import * as RealAppliedMarkdown from "@raceiq/backend-core/setups/applied-change-markdown";
import * as RealRepresentativeLap from "../../../src/experiments/representative-lap";
import * as RealTrackConditions from "@raceiq/backend-core/ai/track-conditions";
import * as RealSetupLineage from "../../../src/experiments/setup-lineage";
import * as RealLapReadQueries from "@raceiq/backend-core/db/lap-read-queries";
import * as RealExperimentLapQueries from "@raceiq/backend-core/db/experiment-lap-queries";
import * as RealActionQueries from "@raceiq/backend-core/db/experiment-action-queries";
import * as RealUndo from "@raceiq/backend-core/experiments/undo"
import * as RealConsult from "../../../src/ai/consult-lap-analyst";
import * as RealCleanLap from "../../../src/experiments/lap-evidence/aggregate";
import * as RealComparison from "@raceiq/backend-core/lap-analysis/comparison"
import * as RealSettings from "@raceiq/backend-core/runtime/config/settings";
import * as RealMastraModel from "../../../src/mastra/model";

let stubsActive = false;
beforeAll(() => {
  stubsActive = true;
  initGameAdapters();
});
afterAll(() => {
  stubsActive = false;
});

/** Route calls through `fake` while this file's tests run, else through `real`. */
function gate<F extends (...args: any[]) => any>(real: F, fake: (...args: any[]) => any): F {
  return ((...args: any[]) => (stubsActive ? fake(...args) : real(...args))) as F;
}

function baseAccSetup() {
  return {
    basicSetup: {
      tyres: { tyrePressure: [26, 26, 26, 26] },
    },
    advancedSetup: {
      mechanicalBalance: { aRBFront: 5, aRBRear: 5, brakeBias: 55 },
      aeroBalance: { splitter: 3, rearWing: 4, rideHeight: [65, 65, 75, 75] },
      dampers: { bumpSlow: [8, 8, 8, 8], reboundSlow: [8, 8, 8, 8] },
      drivetrain: { preload: 40 },
    },
  };
}

// --- observable fakes for the write path ------------------------------------
const writeAppliedSetup = mock(() => ({ setupPath: "fake/path.json", setupSnapshot: null, fileName: "fake.json" }));
const readActiveSetup = mock(async () => ({ ok: true, setup: baseAccSetup(), realPath: "fake/base.json", baseDir: "fake" }));
const createExperimentVersionAndSetHead = mock(async () => null);
const setSessionHead = mock(async () => {});
const recordAction = mock(async () => {});

function completedPackets(): TelemetryPacket[] {
  return Array.from({ length: 180 }, (_, i) => ({
    gameId: "acc", IsRaceOn: 1, LapNumber: 1, LastLap: 0, BestLap: 0,
    CarOrdinal: 100, TrackOrdinal: 5, PositionX: 0, PositionZ: 0,
    TimestampMS: i * 16, CurrentLap: i / 60,
    DistanceTraveled: i * 2, Speed: i < 40 ? 50 : 20,
    VelocityX: i < 40 ? 50 : 20, VelocityY: 0, VelocityZ: 0,
    Steer: i < 40 ? 0 : 50, Brake: 1, Accel: 0,
    TireSlipAngleFL: 0.1, TireSlipAngleFR: 0.1, TireSlipAngleRL: 0, TireSlipAngleRR: 0,
    TireSlipRatioFL: 0.3, TireSlipRatioFR: 0.3, TireSlipRatioRL: 0, TireSlipRatioRR: 0,
    NormSuspensionTravelFL: 0.5, NormSuspensionTravelFR: 0.5,
    NormSuspensionTravelRL: 0.5, NormSuspensionTravelRR: 0.5,
  } as TelemetryPacket));
}

const issueLaps = Array.from({ length: 9 }, (_, i) => ({
  id: 109 - i, lapNumber: 19 - i, lapTime: 90, isValid: true,
}));
const getLapsForExperiment = mock(async (sessionId: number) => sessionId === 61 ? issueLaps : []);
const getLapById = mock(async (lapId: number) =>
  issueLaps.some((lap) => lap.id === lapId) ? { telemetry: completedPackets() } : null);

const fakeCtx = {
  ok: true as const,
  gameId: "acc",
  session: { id: 61, name: "guard-test", headVersionId: 1 },
  tests: [{ id: 1, version: 1, label: "v1", parentVersionId: null, setupPath: "fake/base.json", setupSnapshot: null }],
  activeTest: { id: 1, version: 1, label: "v1", parentVersionId: null, setupPath: "fake/base.json", setupSnapshot: null },
  baseDir: "fake",
  realPath: "fake/base.json",
  setup: baseAccSetup(),
};

mock.module("../../../src/setups/io", () => ({
  ...RealSetupIo,
  readActiveSetup: gate(RealSetupIo.readActiveSetup, readActiveSetup),
  writeAppliedSetup: gate(RealSetupIo.writeAppliedSetup, writeAppliedSetup),
}));
mock.module("@raceiq/backend-core/db/experiment-version-queries", () => ({
  ...RealTestQueries,
  createExperimentVersionAndSetHead: gate(RealTestQueries.createExperimentVersionAndSetHead, createExperimentVersionAndSetHead),
  deleteTestSubtree: gate(RealTestQueries.deleteTestSubtree, mock(async () => ({ deletedIds: [], headMoved: false, prevHeadTestId: 1, newHeadTestId: 1 }))),
  getExperimentVersion: gate(RealTestQueries.getExperimentVersion, mock(async () => ({ id: 1, version: 1 }))),
  getExperimentVersionsByLabel: gate(RealTestQueries.getExperimentVersionsByLabel, mock(async () => null)),
  resolveActiveTestId: gate(RealTestQueries.resolveActiveTestId, mock(async () => 1)),
  setExperimentVersionNotes: gate(RealTestQueries.setExperimentVersionNotes, mock(async () => {})),
  setExperimentVersionNoteGuarded: gate(RealTestQueries.setExperimentVersionNoteGuarded, mock(async () => ({ ok: false, previous: null }))),
  setExperimentVersionNotesGuarded: gate(RealTestQueries.setExperimentVersionNotesGuarded, mock(async () => ({ ok: false, previous: null }))),
}));
mock.module("@raceiq/backend-core/db/experiment-queries", () => ({
  ...RealSessionQueries,
  setSessionHead: gate(RealSessionQueries.setSessionHead, setSessionHead),
  getExperiment: gate(RealSessionQueries.getExperiment, mock(async (id: number) => ({ ...fakeCtx.session, id }))),
}));
mock.module("@raceiq/backend-core/ai/chat-agent", () => ({
  ...RealChatAgent,
  saveAssistantChatMessage: gate(RealChatAgent.saveAssistantChatMessage, mock(async () => {})),
  getChatMemory: gate(RealChatAgent.getChatMemory, mock(() => null)),
}));
mock.module("@raceiq/backend-core/setups/applied-change-markdown", () => ({
  ...RealAppliedMarkdown,
  buildAppliedChangesMarkdown: gate(RealAppliedMarkdown.buildAppliedChangesMarkdown, mock(() => "")),
}));
mock.module("../../../src/experiments/representative-lap", () => ({
  ...RealRepresentativeLap,
  computeSessionSymptoms: gate(RealRepresentativeLap.computeSessionSymptoms, mock(async () => [])),
  computeSessionTrackConditions: gate(RealRepresentativeLap.computeSessionTrackConditions, mock(async () => null)),
}));
mock.module("@raceiq/backend-core/ai/track-conditions", () => ({
  ...RealTrackConditions,
  formatTrackConditions: gate(RealTrackConditions.formatTrackConditions, mock(() => "")),
}));
mock.module("../../../src/experiments/setup-lineage", () => ({
  ...RealSetupLineage,
  loadActiveExperimentContext: gate(RealSetupLineage.loadActiveExperimentContext, mock(async () => fakeCtx)),
}));
mock.module("@raceiq/backend-core/db/lap-read-queries", () => ({
  ...RealLapReadQueries,
  getLapById: gate(RealLapReadQueries.getLapById, getLapById),
}));
mock.module("@raceiq/backend-core/db/experiment-lap-queries", () => ({
  ...RealExperimentLapQueries,
  setLapExperimentExcluded: gate(RealExperimentLapQueries.setLapExperimentExcluded, mock(async () => {})),
  getLapsForExperiment: gate(RealExperimentLapQueries.getLapsForExperiment, getLapsForExperiment),
}));
mock.module("@raceiq/backend-core/db/experiment-action-queries", () => ({
  ...RealActionQueries,
  recordAction: gate(RealActionQueries.recordAction, recordAction),
}));
mock.module("@raceiq/backend-core/experiments/undo", () => ({
  ...RealUndo,
  undoLastAction: gate(RealUndo.undoLastAction, mock(async () => ({ ok: true }))),
}));
mock.module("../../../src/ai/consult-lap-analyst", () => ({
  ...RealConsult,
  consultLapAnalystForSession: gate(RealConsult.consultLapAnalystForSession, mock(async () => ({ ok: true, text: "" }))),
}));
mock.module("../../../src/experiments/lap-evidence/aggregate", () => ({
  ...RealCleanLap,
  loadCleanLapAggregate: gate(RealCleanLap.loadCleanLapAggregate, mock(async () => null)),
}));
mock.module("@raceiq/backend-core/lap-analysis/comparison", () => ({
  ...RealComparison,
  compareLaps: gate(RealComparison.compareLaps, mock(() => ({}))),
}));
mock.module("@raceiq/backend-core/runtime/config/settings", () => ({
  ...RealSettings,
  loadSettings: gate(RealSettings.loadSettings, mock(() => ({ ai: {} }))),
}));
mock.module("../../../src/mastra/model", () => ({
  ...RealMastraModel,
  getMastraModelId: gate(RealMastraModel.getMastraModelId, mock(() => "fake/model")),
}));


const testBranch = (sessionId: number) => ({
  sessionId, headVersionId: 1, versions: fakeCtx.tests, activeVersion: fakeCtx.activeTest,
  session: fakeCtx.session, laps: sessionId === 61 ? issueLaps : [], lapIds: sessionId === 61 ? issueLaps.map((lap) => lap.id) : [],
  setupContext: fakeCtx,
});
const requestContextData: Record<string, unknown> = {
  gameId: "acc", sessionId: 61, "raceiq.experimentChatBranch": testBranch(61),
};
const requestContext = { get: (k: string) => requestContextData[k] };

describe("apply_changes — no-op guard when every change is skipped", () => {
  test("returns ok:false with skipped reasons and creates NO version", async () => {
    writeAppliedSetup.mockClear();
    createExperimentVersionAndSetHead.mockClear();
    setSessionHead.mockClear();

    const result: any = await setupEngineerTools.applyChangesTool.execute!(
      {
        changes: [
          { component: "Front Anti-Roll Bar Stiffness Coefficient", direction: "increase", magnitude: "small", reason: "t" },
          { component: "Rear Hyperdrive Damper", direction: "decrease", magnitude: "small", reason: "t" },
        ],
        goal: "stiffer front",
        driverConfirmed: true,
      },
      { requestContext } as any,
    );

    expect(result.ok).toBe(false);
    expect(result.applied).toEqual([]);
    expect(result.skipped.map((change: { component: string }) => change.component)).toEqual([
      "Front Anti-Roll Bar Stiffness Coefficient", "Rear Hyperdrive Damper",
    ]);

    // The phantom-version bug: none of these may run when nothing applied.
    expect(writeAppliedSetup).not.toHaveBeenCalled();
    expect(createExperimentVersionAndSetHead).not.toHaveBeenCalled();
    expect(setSessionHead).not.toHaveBeenCalled();
  });
});


describe("get_lap_issues — explicit experiment-scoped worker analysis", () => {
  async function invokeIssues(lapId?: number, sessionId = 61) {
    const context = new RequestContext();
    context.set("gameId", "acc");
    context.set("sessionId", sessionId);
    context.set("raceiq.experimentChatBranch", testBranch(sessionId));
    const executionContext = { requestContext: context } as Parameters<NonNullable<typeof setupEngineerTools.getLapIssuesTool.execute>>[1];
    const result = await setupEngineerTools.getLapIssuesTool.execute!({ lapId }, executionContext);
    if (!result || !("ok" in result)) throw new Error("Unexpected tool validation failure");
    return result;
  }

  test("yields before returning deterministic ACC issues with the saved lap identity", async () => {
    const packets = completedPackets();
    const expected = symptomsToIssues(telemetryToSymptoms(packets, detectCorners(packets)), 19)
      .map(({ kind, severity, corner, detail, lapNumber }) => ({ kind, severity, corner, detail, lapNumber }));
    let yielded = false;
    const analysis = invokeIssues(109);
    setImmediate(() => { yielded = true; });
    const result = await analysis;

    expect(yielded).toBe(true);
    expect(result.ok).toBe(true);
    expect(result.laps).toHaveLength(1);
    expect(result.laps[0]).toMatchObject({ lapId: 109, lapNumber: 19, issues: expected });
    expect(result.laps[0].issues.map((issue: { kind: string }) => issue.kind)).toEqual([
      "understeer", "brake-lockup", "understeer", "brake-lockup", "understeer", "brake-lockup",
    ]);
  });

  test("rejects another experiment's lap before reading its telemetry or starting analysis", async () => {
    getLapById.mockClear();
    const result = await invokeIssues(109, 62);

    expect(result.ok).toBe(false);
    expect(result.laps).toEqual([]);
    expect(getLapById).not.toHaveBeenCalled();
  });

  test("keeps simultaneous explicit requests tied to their saved lap identities", async () => {
    const results = await Promise.all([109, 108].map((lapId) => invokeIssues(lapId)));

    for (const [index, result] of results.entries()) {
      expect(result.ok).toBe(true);
      expect(result.laps).toHaveLength(1);
      expect(result.laps[0].lapId).toBe(109 - index);
      expect(result.laps[0].lapNumber).toBe(19 - index);
      expect(result.laps[0].issues.map((issue) => issue.lapNumber)).toEqual(
        Array(6).fill(19 - index),
      );
    }
  });

  test("scans its capped lap pool sequentially without overloading the worker", async () => {
    const result = await invokeIssues();

    expect(result.ok).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.laps.map((lap: { lapId: number }) => lap.lapId)).toEqual(
      [109, 108, 107, 106, 105, 104, 103, 102],
    );
  });

  test("reports a full backlog as a tool failure and accepts later requests", async () => {
    const pending = Array.from({ length: 4 }, () => analyzeLapIssues(completedPackets()));
    try {
      const result = await invokeIssues(109);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/backlog/);
      expect(result.laps).toEqual([]);
    } finally {
      await Promise.all(pending);
    }

    const recovered = await invokeIssues(109);
    expect(recovered.ok).toBe(true);
    expect(recovered.laps[0].issues).toContainEqual(
      expect.objectContaining({ kind: "understeer", lapNumber: 19 }),
    );
  });
});
