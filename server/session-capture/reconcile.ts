import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../db/index";
import { sessions } from "../db/schema";
import { MOTEC_SESSION_SOURCE } from "@raceiq/shared/integrations/motec";
import { SessionRawFileMissingError, reprocessSession } from "./reprocess";
import type { ReprocessResult } from "./reprocess";

const SESSION_PAGE_SIZE = 100;

export interface HistoricalSessionReconcileError {
  sessionId: number;
  message: string;
}

export interface HistoricalSessionReconcileResult {
  scanned: number;
  reprocessed: number;
  missingCapture: number;
  failed: number;
  errors: HistoricalSessionReconcileError[];
}

export async function reconcileHistoricalSessions(onReprocessed?: (reprocessed: ReprocessResult) => void): Promise<HistoricalSessionReconcileResult> {
  const result: HistoricalSessionReconcileResult = {
    scanned: 0,
    reprocessed: 0,
    missingCapture: 0,
    failed: 0,
    errors: [],
  };
  const upperBoundRow = await db
    .select({ id: sql<number>`coalesce(max(${sessions.id}), 0)` })
    .from(sessions)
    .get();
  const upperSessionId = upperBoundRow?.id ?? 0;
  if (upperSessionId === 0) return result;
  let afterSessionId = 0;
  while (true) {
    const page = await db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(
        isNull(sessions.lapDetectorVersion),
        gt(sessions.id, afterSessionId),
        lte(sessions.id, upperSessionId),
        or(
          eq(sessions.captureFormatVersion, 1),
          eq(sessions.source, MOTEC_SESSION_SOURCE),
        ),
      ))
      .orderBy(sessions.id)
      .limit(SESSION_PAGE_SIZE)
      .all();
    if (page.length === 0) break;
    for (const { id } of page) {
      afterSessionId = id;
      result.scanned++;
      try {
        const reprocessed = await reprocessSession(id);
        result.reprocessed++;
        onReprocessed?.(reprocessed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        result.errors.push({ sessionId: id, message });
        if (error instanceof SessionRawFileMissingError) {
          result.missingCapture++;
          console.warn(`[SessionRepair] Session ${id} missing capture: ${message}`);
        } else {
          result.failed++;
          console.error(`[SessionRepair] Session ${id} reconciliation failed: ${message}`);
        }
      }
    }
    if (page.length < SESSION_PAGE_SIZE) break;
  }
  return result;
}
