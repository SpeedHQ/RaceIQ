import { afterEach, expect, test } from "bun:test";
import { classificationMigrationActions as actions, classificationMigrationStore as store, isClassificationMigrationDismissed } from "../src/stores/classification-migration";
import type { ClassificationMigrationStatus } from "@raceiq/shared/racing/laps/classification-migration";

function status(revision: number, phase: ClassificationMigrationStatus["status"] = "running"): ClassificationMigrationStatus {
  return { version: 1, revision, status: phase, total: 8, pending: 0, running: 0, completed: 7, limited: 1, failed: 0, aggregatesPending: phase === "running" };
}
afterEach(() => store.setState({ status: null, recordings: [], error: null, dismissedRevision: null, dismissedTerminalResult: null, retrying: [] }));

test("dismissed active classification stays hidden through summary refresh and completion", () => {
  actions.applyStatus(status(10));
  actions.dismiss(10);
  actions.applyStatus(status(11));
  expect(store.get().dismissedRevision).toBe(11);
  expect(store.get().status?.aggregatesPending).toBe(true);
  actions.applyStatus(status(12, "complete"));
  expect(store.get().dismissedRevision).toBe(12);
  expect(store.get().status?.status).toBe("complete");
  expect(isClassificationMigrationDismissed(store.get())).toBe(true);
  expect(store.get().dismissedRevision).not.toBe(13);
  actions.applyStatus(status(14));
  expect(store.get().dismissedRevision).not.toBe(14);
});

test("terminal dismissal survives unrelated revisions but reopens for new work or changed results", () => {
  actions.applyStatus(status(30, "complete"));
  actions.dismiss(30);
  actions.applyStatus({ ...status(31, "complete"), aggregatesPending: false });
  expect(isClassificationMigrationDismissed(store.get())).toBe(true);
  actions.applyStatus(status(32));
  expect(store.get().dismissedTerminalResult).toBeNull();
  expect(isClassificationMigrationDismissed(store.get())).toBe(false);
  actions.applyStatus(status(33, "attention"));
  expect(isClassificationMigrationDismissed(store.get())).toBe(false);

  actions.dismiss(33);
  actions.applyStatus({ ...status(34, "attention"), failed: 1 });
  expect(isClassificationMigrationDismissed(store.get())).toBe(false);
});

test("terminal dismissal tracks recording outcomes but ignores order and revisions", () => {
  actions.applyStatus(status(40, "attention"));
  const recording = { recordingId: "a", sessionIds: [1], state: "failed" as const, reason: "processing_error" as const, retryable: true };
  actions.applyRecordings(40, [recording]);
  actions.dismiss(40);
  actions.applyStatus(status(41, "attention"));
  actions.applyRecordings(41, [{ ...recording, sessionIds: [2] }]);
  expect(isClassificationMigrationDismissed(store.get())).toBe(true);
  actions.applyRecordings(41, [{ ...recording, recordingId: "b" }]);
  expect(isClassificationMigrationDismissed(store.get())).toBe(false);
  actions.applyRecordings(41, [{ ...recording, reason: "missing_source" }]);
  expect(isClassificationMigrationDismissed(store.get())).toBe(false);
});

test("active dismissal captures terminal identity and reopens for changed run version", () => {
  actions.applyStatus(status(50));
  const recording = { recordingId: "a", sessionIds: [1], state: "running" as const, reason: null, retryable: false };
  actions.applyRecordings(50, [recording]);
  actions.dismiss(50);
  actions.applyStatus(status(51));
  actions.applyStatus(status(52, "complete"));
  actions.applyRecordings(52, [{ ...recording, state: "completed" }]);
  actions.applyStatus({ ...status(53, "complete"), aggregatesPending: false });
  expect(isClassificationMigrationDismissed(store.get())).toBe(true);
  actions.applyStatus({ ...status(54, "complete"), version: 2, aggregatesPending: false });
  expect(isClassificationMigrationDismissed(store.get())).toBe(false);
});

test("stale classification responses cannot reopen a dismissed notice", () => {
  actions.applyStatus(status(20));
  actions.dismiss(20);
  actions.applyStatus(status(19));
  expect(store.get().status?.revision).toBe(20);
  expect(store.get().dismissedRevision).toBe(20);
});
