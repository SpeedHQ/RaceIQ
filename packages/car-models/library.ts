import type { CarModelEnrichment } from "@raceiq/scene-3d/model-types";

export type Model = CarModelEnrichment & { hasModel: boolean };
export type Fit = NonNullable<Model["bodyFit"]>;
export interface Assignment {
  id: string;
  fit: Fit;
  wheelbase?: number;
  frontTrack?: number;
  rearTrack?: number;
}
export interface LibraryModel {
  id: string;
  name: string;
  config: Partial<Model>;
}
export const neutralFit: Fit = { roll: 0, yaw: 0, pitch: 0, scale: 1, x: 0, y: 0, z: 0 };
const models = new Map<string, LibraryModel>();
let database: Promise<IDBDatabase> | undefined;
let hydration: Promise<void> | undefined;
type StoredModel = { id: string; name: string; blob: Blob };
function requestResult<T>(request: IDBRequest<T>) {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
  return promise;
}
async function db() {
  if (database) return database;
  const request = indexedDB.open("raceiq-car-models", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("models", { keyPath: "id" });
  return (database = requestResult(request).catch((error) => {
    database = undefined;
    throw error;
  }));
}
function register(row: StoredModel) {
  if (!models.has(row.id)) models.set(row.id, { id: row.id, name: row.name, config: { modelPath: URL.createObjectURL(row.blob), importedBody: true } });
}
export function registerShipped(name: string, config: Model) {
  if (config.modelPath && !models.has(config.modelPath)) models.set(config.modelPath, { id: config.modelPath, name, config });
}
export function loadLibrary() {
  return (hydration ??= db()
    .then(async (database) => {
      const rows: StoredModel[] = await requestResult(database.transaction("models").objectStore("models").getAll());
      rows.forEach(register);
    })
    .catch((error) => {
      hydration = undefined;
      throw error;
    }));
}
export const listModels = () => [...models.values()];
const assignmentKey = (game: string, car: string) => `raceiq:model:${JSON.stringify([game, car])}`;
export function assignment(game: string, car?: string): Assignment | null {
  try {
    return car ? JSON.parse(localStorage.getItem(assignmentKey(game, car)) ?? "null") : null;
  } catch {
    return null;
  }
}
export function saveAssignment(game: string, car: string, choice: Assignment | null) {
  if (!car) throw new Error("Missing car ID");
  if (choice) localStorage.setItem(assignmentKey(game, car), JSON.stringify(choice));
  else localStorage.removeItem(assignmentKey(game, car));
}
export function fittedModel(base: Model, choice: Assignment | null): Model {
  const entry = choice && models.get(choice.id);
  if (!entry || !choice) return base;
  return {
    ...base,
    glbWheelbase: undefined,
    glbOffsetX: undefined,
    glbOffsetY: undefined,
    glbOffsetZ: undefined,
    solidHiddenMeshes: undefined,
    ...entry.config,
    hasModel: true,
    bodyFit: choice.fit,
    halfWheelbase: choice.wheelbase === undefined ? base.halfWheelbase : choice.wheelbase / 2,
    halfFrontTrack: choice.frontTrack === undefined ? base.halfFrontTrack : choice.frontTrack / 2,
    halfRearTrack: choice.rearTrack === undefined ? base.halfRearTrack : choice.rearTrack / 2,
  };
}
export async function importModel(file: File) {
  if (!file.name.toLowerCase().endsWith(".glb") || file.size > 64 * 1024 * 1024 || !file.size) throw new Error("Invalid GLB");
  const worker = new Worker(new URL("./optimise.worker.ts", import.meta.url), { type: "module" });
  try {
    const result = Promise.withResolvers<Blob>();
    worker.onmessage = (event) => (event.data instanceof Blob ? result.resolve(event.data) : result.reject(new Error("Invalid GLB")));
    worker.onerror = result.reject;
    worker.postMessage(file);
    const blob = await result.promise;
    const row = { id: Array.from(crypto.getRandomValues(new Uint8Array(16)), (n) => n.toString(16).padStart(2, "0")).join(""), name: file.name.slice(0, -4), blob };
    const database = await db();
    const written = Promise.withResolvers<void>();
    const tx = database.transaction("models", "readwrite");
    tx.oncomplete = () => written.resolve();
    tx.onabort = () => written.reject(tx.error);
    tx.objectStore("models").add(row);
    await written.promise;
    register(row);
    return row.id;
  } finally {
    worker.terminate();
  }
}
