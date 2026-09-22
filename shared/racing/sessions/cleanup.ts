export type SessionCleanupRequest =
  | { mode: "older-than"; olderThanDays: 30 | 90 | 180 | 365 }
  | { mode: "selected"; sessionIds: number[] };

export interface SessionCleanupPreview {
  candidateSessionIds: number[];
  protectedSessionIds: number[];
  unavailableSessionIds: number[];
  fileCount: number;
  reclaimableBytes: number;
}

export interface SessionCleanupResult extends SessionCleanupPreview {
  cleanedSessionIds: number[];
  deletedFiles: number;
  freedBytes: number;
  failed: { sessionIds: number[]; message: string }[];
}
