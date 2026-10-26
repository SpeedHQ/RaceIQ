import { access } from "node:fs/promises";
import { join } from "node:path";
import { resolveDataDir } from "./config/data-dir";

export type OnlineWorkerTestBarrier = "before_projection_cas" | "after_selection_commit_before_outbox" | "before_upload_transport" | "before_recording_source_publish" | "before_recovery_source_publish" | "before_recovery_state_commit" | "after_recovery_state_commit" | "before_reprocess_resume" | "after_reprocess_claim_before_rebuild" | "before_reprocess_source_complete" | "after_outbox_admission_before_projection_ack";
export type OnlineWorkerTestEvent = "projection_backfill_batch" | "recording_readiness_recovery_batch" | "projection_candidate_page" | "projection_preparation" | "projection_evaluation_committed" | "outbox_reconciled" | "recording_source_checked" | "barrier_reached";
type OnlineWorkerTestFields = {
  gameId?: string;
  trackId?: string;
  carId?: string;
  count?: number;
  revision?: number;
  outcome?: string;
  phase?: OnlineWorkerTestBarrier;
};
const BARRIER_TIMEOUT_MS = 30_000;
const BARRIER_POLL_MS = 10;

function enabled(): boolean {
  return process.env.NODE_ENV === "test" && process.env.RACEIQ_E2E === "1";
}

/** Bounded test-only trace. Never include account IDs, identities, paths, or payload data. */
export function traceOnlineWorkerTestEvent(event: OnlineWorkerTestEvent, fields: OnlineWorkerTestFields = {}): void {
  if (!enabled()) return;
  console.info(`[RACEIQ_ONLINE_TEST]${JSON.stringify({ event, ...fields })}`);
}

/** Test fixtures release barriers by creating the named marker inside isolated DATA_DIR. */
export async function waitOnlineWorkerTestBarrier(
  phase: OnlineWorkerTestBarrier,
  board: { gameId?: string; trackId?: string; carId?: string } = {},
): Promise<void> {
  const configuredPhases=process.env.RACEIQ_ONLINE_TEST_BARRIER?.split(",").map((value)=>value.trim()).filter(Boolean)??[];
  if(!enabled()||!configuredPhases.includes(phase))return;
  const releaseFile = join(resolveDataDir(), `.online-upload-test-release-${phase}`);
  traceOnlineWorkerTestEvent("barrier_reached", { phase, ...board });
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try { await access(releaseFile); return; }
    catch { await Bun.sleep(BARRIER_POLL_MS); }
  }
  throw new Error(`online_upload_test_barrier_timeout:${phase}`);
}
