import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

function canonicalPath(path: string): string {
  const absolute = resolve(path);
  const missing: string[] = [];
  let ancestor = absolute;
  while (true) {
    try {
      return resolve(realpathSync(ancestor), ...missing.reverse());
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return absolute;
      missing.push(basename(ancestor));
      ancestor = parent;
    }
  }
}

const activeLmuOpponentSources = new Map<string, { live: number; import: number }>();

export function getActiveLmuOpponentSourcePaths(): string[] {
  return [...activeLmuOpponentSources.keys()];
}

export function registerActiveLmuOpponentSource(path: string, kind: "live" | "import" = "live"): () => void {
  const key = canonicalPath(path);
  const counts = activeLmuOpponentSources.get(key) ?? { live: 0, import: 0 };
  counts[kind]++;
  activeLmuOpponentSources.set(key, counts);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    const current = activeLmuOpponentSources.get(key);
    if (!current) return;
    current[kind]--;
    if (current.live + current.import === 0) activeLmuOpponentSources.delete(key);
  };
}

export function isActiveLmuOpponentSource(path: string): boolean {
  return activeLmuOpponentSources.has(canonicalPath(path));
}

export function getActiveLmuOpponentSourceKind(path: string): "live" | "import" | null {
  const counts = activeLmuOpponentSources.get(canonicalPath(path));
  if (!counts) return null;
  return counts.import > 0 ? "import" : "live";
}

let imports = 0;
type StorageOperation = "layout-migration" | "directory-move" | "downsample" | "opponent-index";
let reservedOperation: { kind: StorageOperation; token: object } | null = null;
let relocating = false;
const reservationWaiters = new Set<() => void>();
function notifyReservationWaiters(): void {
  for (const resolve of reservationWaiters) resolve();
}

function waitForStorageActivityChange(): Promise<void> {
  return new Promise((resolveWait) => {
    const resolve = () => {
      reservationWaiters.delete(resolve);
      resolveWait();
    };
    reservationWaiters.add(resolve);
    if (!imports && !reservedOperation && !relocating) resolve();
  });
}

export class RecordingStorageBusyError extends Error {
  readonly code: "IMPORT_ACTIVE" | "MOVE_ACTIVE";
  constructor(code: "IMPORT_ACTIVE" | "MOVE_ACTIVE") {
    super(code === "IMPORT_ACTIVE" ? "Recording storage import is active" : "Recording storage operation is active");
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
    notifyReservationWaiters();
  };
}

export async function reserveRecordingStorageOperationWhenIdle(kind: StorageOperation): Promise<() => void> {
  while (true) {
    try {
      return reserveRecordingStorageOperation(kind);
    } catch (error) {
      if (!(error instanceof RecordingStorageBusyError)) throw error;
      await waitForStorageActivityChange();
    }
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
      notifyReservationWaiters();
    }
  };
}

export function getRecordingStorageActivity(): { imports: number; relocating: boolean } {
  return { imports, relocating };
}
