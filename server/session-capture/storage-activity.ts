let imports = 0;
type StorageOperation = "layout-migration" | "directory-move";
let reservedOperation: { kind: StorageOperation; token: object } | null = null;
let relocating = false;

export class RecordingStorageBusyError extends Error {
  readonly code: "IMPORT_ACTIVE" | "MOVE_ACTIVE";
  constructor(code: "IMPORT_ACTIVE" | "MOVE_ACTIVE") {
    super(code === "IMPORT_ACTIVE" ? "Recording storage import is active" : "Recording storage move is active");
    this.code = code;
    this.name = "RecordingStorageBusyError";
  }
}
export function reserveRecordingStorageOperation(kind: StorageOperation): () => void {
  if (imports) throw new RecordingStorageBusyError("IMPORT_ACTIVE");
  if (reservedOperation || relocating) throw new RecordingStorageBusyError("MOVE_ACTIVE");
  const reservation = { kind, token: {} };
  reservedOperation = reservation;
  relocating = true;
  return () => {
    if (reservedOperation?.token !== reservation.token) return;
    reservedOperation = null;
    relocating = false;
  };
}

export function beginRecordingStorageImport(): () => void {
  if (relocating) throw new RecordingStorageBusyError("MOVE_ACTIVE");
  imports++;
  let released = false;
  return () => {
    if (!released) {
      released = true;
      imports--;
    }
  };
}

export function getRecordingStorageActivity(): { imports: number; relocating: boolean } {
  return { imports, relocating };
}
