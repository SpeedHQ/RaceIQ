/** Active setup lineage and experiment-context resolution. */
import type { GameId } from "../../shared/games/ids";
import { getLapMetaById } from "../db/lap-read-queries";
import { getLapsForExperiment } from "../db/experiment-lap-queries";
import { getExperiment } from "../db/experiment-queries";
import { listExperimentVersions, updateExperimentVersionSetupSnapshot } from "../db/experiment-version-queries";
import { resolveGuardedSetupFile, type AccGameId } from "../setups/file-guard";

export type ExperimentGameId = AccGameId | "f1-2025";

/** Only ACC/AC-EVO write a real setup file the user loads from the setup menu. */
export function gameHasSetupFile(gameId: ExperimentGameId): boolean {
  return gameId === "acc" || gameId === "ac-evo";
}

/**
 * Walk up the version tree from `versionId` to the nearest ancestor that
 * actually carries a setup. Drill nodes have neither a path nor snapshot and
 * must not reset the car to the experiment base. Cycle-guarded because
 * `parentVersionId` has no FK and is set by several call sites.
 */
export function nearestSetupAncestor<
  T extends {
    id: number;
    parentVersionId: number | null;
    setupPath: string | null;
    setupSnapshot: string | null;
  },
>(versions: T[], versionId: number | null): T | null {
  const byId = new Map(versions.map((version) => [version.id, version]));
  const seen = new Set<number>();
  let cursor = versionId != null ? (byId.get(versionId) ?? null) : null;
  while (cursor && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    if (cursor.setupPath != null || cursor.setupSnapshot != null) return cursor;
    cursor = cursor.parentVersionId != null ? (byId.get(cursor.parentVersionId) ?? null) : null;
  }
  return null;
}

/** Resolve setup path in force at a version, walking past drill nodes. */
export async function resolveSetupPathForVersion(experimentId: number, versionId: number | null): Promise<string | null> {
  const [session, versions] = await Promise.all([getExperiment(experimentId), listExperimentVersions(experimentId)]);
  const ancestor = nearestSetupAncestor(versions, versionId);
  return ancestor?.setupPath ?? session?.baseSetupPath ?? null;
}

export type ActiveExperimentContext =
  | {
      ok: true;
      gameId: ExperimentGameId;
      session: NonNullable<Awaited<ReturnType<typeof getExperiment>>>;
      tests: Awaited<ReturnType<typeof listExperimentVersions>>;
      activeTest: Awaited<ReturnType<typeof listExperimentVersions>>[number] | null;
      /** File games only — null for F1 (no on-disk setup). */
      baseDir: string | null;
      /** File games only — null for F1 (no on-disk setup). */
      realPath: string | null;
      setup: any;
    }
  | { ok: false; status: 400 | 404 | 409 | 500; error: string };

/** Resolve session, history, checked-out version, and active setup in one call. */
export async function loadActiveExperimentContext(sessionId: number): Promise<ActiveExperimentContext> {
  const session = await getExperiment(sessionId);
  if (!session) return { ok: false, status: 404, error: "Tuning session not found" };

  const gameId = session.gameId as GameId;
  if (gameId !== "acc" && gameId !== "ac-evo" && gameId !== "f1-2025") {
    return { ok: false, status: 400, error: "The setup engineer only supports ACC, AC-EVO and F1 2025" };
  }

  const tests = await listExperimentVersions(sessionId);
  const activeTest =
    session.headVersionId != null ? (tests.find((test) => test.id === session.headVersionId) ?? (tests.length ? tests[tests.length - 1]! : null)) : tests.length ? tests[tests.length - 1]! : null;
  const setupAncestor = nearestSetupAncestor(tests, activeTest?.id ?? null);

  if (gameId === "f1-2025") {
    let setupSnapshot = setupAncestor?.setupSnapshot ?? null;
    if (!setupSnapshot && activeTest) {
      setupSnapshot = await captureF1SetupFromLaps(sessionId);
      // Backfill the setup-bearing node, never a drill arm.
      const backfillTarget = setupAncestor ?? (activeTest.kind !== "drill" ? activeTest : null);
      if (setupSnapshot && backfillTarget) {
        await updateExperimentVersionSetupSnapshot(backfillTarget.id, setupSnapshot);
      }
    }
    if (!setupSnapshot) {
      return {
        ok: false,
        status: 400,
        error: "No base setup captured yet — drive a lap or capture the current setup first.",
      };
    }
    let setup: any;
    try {
      setup = JSON.parse(setupSnapshot);
    } catch {
      return { ok: false, status: 500, error: "Stored F1 setup snapshot is corrupt JSON." };
    }
    return { ok: true, gameId, session, tests, activeTest, baseDir: null, realPath: null, setup };
  }

  const setupPath = setupAncestor?.setupPath ?? session.baseSetupPath ?? null;
  if (!setupPath) {
    return { ok: false, status: 400, error: "No base setup on this session — create it from a saved setup first." };
  }
  const guarded = await resolveGuardedSetupFile(gameId, setupPath);
  if (!guarded.ok) return { ok: false, status: guarded.status, error: guarded.error };
  return {
    ok: true,
    gameId,
    session,
    tests,
    activeTest,
    baseDir: guarded.baseDir,
    realPath: guarded.realPath,
    setup: guarded.setup,
  };
}

/** Return newest persisted F1 setup snapshot. */
export async function captureF1SetupFromLaps(experimentId: number): Promise<string | null> {
  const sessionLaps = await getLapsForExperiment(experimentId);
  for (const meta of sessionLaps) {
    const lap = await getLapMetaById(meta.id);
    if (lap?.carSetup) return lap.carSetup;
  }
  return null;
}
