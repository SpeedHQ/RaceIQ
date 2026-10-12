let imports = 0;
let relocating = false;

export class RecordingStorageBusyError extends Error {
  readonly code: "IMPORT_ACTIVE" | "MOVE_ACTIVE";
  constructor(code: "IMPORT_ACTIVE" | "MOVE_ACTIVE") {
    super(code === "IMPORT_ACTIVE" ? "Recording storage import is active" : "Recording storage move is active");
    this.code = code;
    this.name = "RecordingStorageBusyError";
  }
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

export function setRecordingStorageRelocating(value: boolean): void {
  relocating = value;
}
