import { createStore, useSelector } from "@tanstack/react-store";
import type { ClassificationMigrationRecording, ClassificationMigrationStatus } from "@raceiq/shared/racing/laps/classification-migration";

export type ClassificationMigrationState = {
  status: ClassificationMigrationStatus | null;
  recordings: ClassificationMigrationRecording[];
  error: string | null;
  dismissedRevision: number | null;
  retrying: string[];
};

const initial: ClassificationMigrationState = { status: null, recordings: [], error: null, dismissedRevision: null, retrying: [] };
export const classificationMigrationStore = createStore(initial);

export const classificationMigrationActions = {
  applyStatus(status: ClassificationMigrationStatus) {
    classificationMigrationStore.setState((state) => status.revision < (state.status?.revision ?? -1) ? state : { ...state, status });
  },
  applyRecordings(revision: number, recordings: ClassificationMigrationRecording[]) {
    classificationMigrationStore.setState((state) => {
      if (revision < (state.status?.revision ?? -1)) return state;
      if (state.status && revision !== state.status.revision) return state;
      return { ...state, recordings };
    });
  },
  setError(error: string) { classificationMigrationStore.setState((state) => ({ ...state, error })); },
  clearError() { classificationMigrationStore.setState((state) => ({ ...state, error: null })); },
  dismiss(revision: number) { classificationMigrationStore.setState((state) => ({ ...state, dismissedRevision: revision })); },
  setRetrying(recordingId: string, retrying: boolean) {
    classificationMigrationStore.setState((state) => ({ ...state, retrying: retrying ? [...new Set([...state.retrying, recordingId])] : state.retrying.filter((id) => id !== recordingId) }));
  },
};

export function useClassificationMigration<T>(selector: (state: ClassificationMigrationState) => T): T {
  return useSelector(classificationMigrationStore, selector, { compare: Object.is });
}
