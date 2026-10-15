import type { ClassificationMigrationRecording, ClassificationMigrationStatus } from "@raceiq/shared/racing/laps/classification-migration";
import { client } from "@/lib/rpc";
import { classificationMigrationActions, classificationMigrationStore } from "@/stores/classification-migration";

async function refreshOnce() {
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const statusResponse = await client.api.sessions["classification-migration-status"].$get();
      if (!statusResponse.ok) throw new Error("status");
      const status = await statusResponse.json() as ClassificationMigrationStatus;
      const recordings: ClassificationMigrationRecording[] = [];
      let cursor: string | undefined;
      let restart = false;
      do {
        const response = await client.api.sessions["classification-migration-recordings"].$get({ query: { ...(cursor ? { cursor } : {}), limit: "100" } });
        if (response.status === 409) { restart = true; break; }
        if (!response.ok) throw new Error("recordings");
        const page = await response.json();
        if (page.revision !== status.revision) { restart = true; break; }
        recordings.push(...page.recordings);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      if (restart || (classificationMigrationStore.get().status?.revision ?? -1) > status.revision) continue;
      classificationMigrationActions.applyStatus(status);
      classificationMigrationActions.applyRecordings(status.revision, recordings);
      classificationMigrationActions.clearError();
      return;
    }
    classificationMigrationActions.setError("stale");
  } catch {
    classificationMigrationActions.setError("unavailable");
  }
}

let refreshFlight: Promise<void> | null = null;
let refreshAgain = false;
let snapshotRefreshTimer: ReturnType<typeof setTimeout> | undefined;

export function refreshClassificationMigration(): Promise<void> {
  if (refreshFlight) {
    refreshAgain = true;
    return refreshFlight;
  }
  refreshFlight = (async () => {
    await refreshOnce();
    if (refreshAgain) {
      refreshAgain = false;
      await refreshOnce();
      if (refreshAgain) {
        refreshAgain = false;
        setTimeout(() => void refreshClassificationMigration(), 300);
      }
    }
  })().finally(() => { refreshFlight = null; });
  return refreshFlight;
}

function scheduleSnapshotRefresh() {
  if (snapshotRefreshTimer !== undefined) clearTimeout(snapshotRefreshTimer);
  snapshotRefreshTimer = setTimeout(() => {
    snapshotRefreshTimer = undefined;
    void refreshClassificationMigration();
  }, 200);
}

export async function retryClassificationRecording(recordingId: string) {
  if (classificationMigrationStore.get().retrying.includes(recordingId)) return false;
  classificationMigrationActions.setRetrying(recordingId, true);
  try {
    const response = await client.api.sessions["classification-migration-retry"].$post({ json: { recordingId } });
    if (!response.ok) throw new Error("retry");
    await refreshClassificationMigration();
    return true;
  } catch {
    classificationMigrationActions.setError("retry");
    return false;
  } finally {
    classificationMigrationActions.setRetrying(recordingId, false);
  }
}

export function acceptClassificationMigrationSnapshot(status: ClassificationMigrationStatus) {
  const previous = classificationMigrationStore.get().status;
  if (previous && status.revision <= previous.revision) return;
  classificationMigrationActions.applyStatus(status);
  scheduleSnapshotRefresh();
}
