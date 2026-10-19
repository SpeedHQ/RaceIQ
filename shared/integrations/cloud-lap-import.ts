export type CloudLapImportStatus =
  | "idle"
  | "awaiting_sign_in"
  | "downloading"
  | "validating"
  | "registering"
  | "complete"
  | "error";

export interface CloudLapImportState {
  status: CloudLapImportStatus;
  lapId: string | null;
  localLap: { id: number; gameId: string; sessionId: number } | null;
  error: { code: string; retryable: boolean } | null;
  activationId: number | null;
}

export const IDLE_CLOUD_LAP_IMPORT: CloudLapImportState = {
  status: "idle",
  lapId: null,
  localLap: null,
  error: null,
  activationId: null,
};
