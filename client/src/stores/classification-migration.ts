import { createStore, useSelector } from "@tanstack/react-store";
import type { ClassificationMigrationRecording, ClassificationMigrationStatus } from "@raceiq/shared/racing/laps/classification-migration";

export type ClassificationMigrationState = {
  status: ClassificationMigrationStatus | null;
  recordings: ClassificationMigrationRecording[];
  error: string | null;
  dismissedRevision: number | null;
  dismissedTerminalResult: string | null;
  retrying: string[];
};

function terminalResult(status: ClassificationMigrationStatus, recordings: ClassificationMigrationRecording[]): string {
  const results = recordings.map(({ recordingId, state, reason, retryable }) => [recordingId, state, reason, retryable] as const)
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([status.version, status.status, status.total, status.completed, status.limited, status.failed, results]);
}

const initial: ClassificationMigrationState = { status: null, recordings: [], error: null, dismissedRevision: null, dismissedTerminalResult: null, retrying: [] };
export const classificationMigrationStore = createStore(initial);

export const classificationMigrationActions = {
  applyStatus(status: ClassificationMigrationStatus) {
    classificationMigrationStore.setState((state) => {
      if (status.revision < (state.status?.revision ?? -1)) return state;
      // Dismissing an active run also dismisses its later progress and completion.
      // A subsequent run remains visible because it starts after a terminal status.
      const continuedDismissal = state.dismissedRevision === state.status?.revision && state.status?.status === "running";
      const dismissedRevision = continuedDismissal ? status.revision : state.dismissedRevision;
      const next = { ...state, status, dismissedRevision };
      const dismissedTerminalResult = status.status === "running"
        ? null
        : continuedDismissal
          ? terminalResult(status, state.recordings)
          : state.dismissedTerminalResult;
      return { ...next, dismissedTerminalResult };
    });
  },
  applyRecordings(revision: number, recordings: ClassificationMigrationRecording[]) {
    classificationMigrationStore.setState((state) => {
      if (revision < (state.status?.revision ?? -1)) return state;
      if (state.status && revision !== state.status.revision) return state;
      return {
        ...state,
        recordings,
        dismissedTerminalResult: state.status && state.status.status !== "running" && state.dismissedRevision === revision
          ? terminalResult(state.status, recordings)
          : state.dismissedTerminalResult,
      };
    });
  },
  setError(error: string) { classificationMigrationStore.setState((state) => ({ ...state, error })); },
  clearError() { classificationMigrationStore.setState((state) => ({ ...state, error: null })); },
  dismiss(revision: number) {
    classificationMigrationStore.setState((state) => ({
      ...state,
      dismissedRevision: revision,
      dismissedTerminalResult: state.status?.revision === revision && state.status.status !== "running"
        ? terminalResult(state.status, state.recordings)
        : state.dismissedTerminalResult,
    }));
  },
  setRetrying(recordingId: string, retrying: boolean) {
    classificationMigrationStore.setState((state) => ({ ...state, retrying: retrying ? [...new Set([...state.retrying, recordingId])] : state.retrying.filter((id) => id !== recordingId) }));
  },
};

export function isClassificationMigrationDismissed(state: ClassificationMigrationState): boolean {
  const status = state.status;
  if (!status || status.status === "idle") return false;
  if (state.dismissedRevision === status.revision) return true;
  return status.status !== "running" && state.dismissedTerminalResult === terminalResult(status, state.recordings);
}

export function useClassificationMigration<T>(selector: (state: ClassificationMigrationState) => T): T {
  return useSelector(classificationMigrationStore, selector, { compare: Object.is });
}
