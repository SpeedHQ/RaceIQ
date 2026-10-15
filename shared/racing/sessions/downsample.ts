import type { RecordingFrequencyHz } from "../../platform/runtime/recording-frequency";

export type SessionDownsampleRequest =
  | { mode: "all"; targetHz: RecordingFrequencyHz }
  | { mode: "older-than"; olderThanDays: 30 | 90 | 180 | 365; targetHz: RecordingFrequencyHz };

export type SessionDownsampleSkip = {
  sessionIds: number[];
  reason: "favorite" | "shared-age-conflict" | "missing" | "unowned" | "unsupported-format"
    | "unreliable-time" | "already-at-or-below-target" | "not-smaller";
};

export type SessionDownsamplePreview = {
  request: SessionDownsampleRequest;
  candidateSessionIds: number[];
  fileCount: number;
  sourceBytes: number;
  skipped: SessionDownsampleSkip[];
};

export type SessionDownsampleStatus = {
  status: "idle" | "running" | "success" | "partial" | "error";
  request: SessionDownsampleRequest | null;
  done: number;
  total: number;
  convertedFiles: number;
  freedBytes: number;
  skipped: SessionDownsampleSkip[];
  failed: { sessionIds: number[]; message: string }[];
  error: string | null;
};
