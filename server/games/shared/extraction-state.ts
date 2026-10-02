export type ExtractionStatus = "idle" | "running" | "done" | "error";

export interface ExtractionState {
  status: ExtractionStatus;
  installed: boolean;
  extracted: number;
  failed: number;
  total: number;
  current: string;
  error: string;
}

export function createExtractionState(installed: boolean, total: number): ExtractionState {
  return {
    status: "idle",
    installed,
    extracted: 0,
    failed: 0,
    total,
    current: "",
    error: "",
  };
}
