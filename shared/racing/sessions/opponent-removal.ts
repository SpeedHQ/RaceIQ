export type OpponentRemovalRequest = { sessionIds: number[] };

export type OpponentRemovalSkip = {
  sessionIds: number[];
  reason: "not-found" | "not-recorded" | "already-removed" | "unsupported-format" | "unowned" | "shared-reference" | "invalid-source";
};

export type OpponentRemovalPreview = {
  request: OpponentRemovalRequest;
  candidateSessionIds: number[];
  companionBytes: number;
  rewriteSessionIds: number[];
  skipped: OpponentRemovalSkip[];
};

export type OpponentRemovalStatus = {
  status: "idle" | "running" | "success" | "partial" | "error";
  request: OpponentRemovalRequest | null;
  done: number;
  total: number;
  removedSessionIds: number[];
  freedBytes: number;
  cleanupPendingSessionIds: number[];
  skipped: OpponentRemovalSkip[];
  failed: { sessionIds: number[]; message: string }[];
  error: string | null;
};
