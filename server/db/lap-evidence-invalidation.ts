import { inArray, or } from "drizzle-orm";
import { db } from "./index";
import {
  compareAnalyses,
  lapAnalyses,
  lapMetrics,
  laps,
  sessions,
} from "./schema";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface LapEvidenceInvalidationOptions {
  lapIds: readonly number[];
  sessionId?: number;
  telemetryBoundariesChanged?: boolean;
}

/**
 * Invalidate every persisted decision and derived cache backed by lap evidence.
 * Callers changing evidence must pass their transaction so mutation and
 * invalidation commit atomically.
 */
export async function invalidateLapEvidence(
  options: LapEvidenceInvalidationOptions,
  transaction?: DbTransaction,
): Promise<void> {
  const invalidate = async (tx: DbTransaction): Promise<void> => {
    if (options.lapIds.length > 0) {
      const lapIds = [...new Set(options.lapIds)];
      await tx
        .update(laps)
        .set({
          eligibility: null,
          qualitySchemaVersion: null,
          qualityPolicyVersion: null,
          qualityConfigVersion: null,
          qualityGeneration: null,
          ...(options.telemetryBoundariesChanged
            ? { fuelPerLap: null, tyreWear: null }
            : {}),
        })
        .where(inArray(laps.id, lapIds))
        .run();
      await tx
        .delete(lapAnalyses)
        .where(inArray(lapAnalyses.lapId, lapIds))
        .run();
      await tx
        .delete(compareAnalyses)
        .where(
          or(
            inArray(compareAnalyses.lapAId, lapIds),
            inArray(compareAnalyses.lapBId, lapIds),
          ),
        )
        .run();
      await tx
        .delete(lapMetrics)
        .where(inArray(lapMetrics.lapId, lapIds))
        .run();
    }

    if (options.sessionId !== undefined) {
      await tx
        .update(sessions)
        .set({
          qualitySchemaVersion: null,
          qualityPolicyVersion: null,
          qualityConfigVersion: null,
          qualityGeneration: null,
        })
        .where(inArray(sessions.id, [options.sessionId]))
        .run();
    }
  };

  if (transaction) {
    await invalidate(transaction);
  } else {
    await db.transaction(invalidate);
  }
}
