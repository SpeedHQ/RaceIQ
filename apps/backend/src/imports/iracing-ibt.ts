import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { resolveDataDir } from "@raceiq/backend-core/runtime/config/data-dir";
import {
  IbtImportError,
  ibtFrames,
  previewIbtFile,
  type IbtImportPreview,
} from "@raceiq/game-iracing/ibt-preview";
import { registerImportedIRacingIdentity } from "@raceiq/game-iracing/identity";
import { importSessionFrames, type ImportSessionResult } from "@raceiq/backend-core/session-capture/import-pipeline";
import type { SessionOwnership } from "@raceiq/shared/racing/sessions/types";

const STAGE_TTL_MS = 30 * 60 * 1000;
export const MAX_IBT_BYTES = 8 * 1024 * 1024 * 1024;
const TOKEN_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface StagedIbtManifest {
  version: 1;
  createdAt: number;
  preview: IbtImportPreview;
}

function stageDir(): string {
  const path = resolve(resolveDataDir(), "imports", "ibt");
  mkdirSync(path, { recursive: true });
  return path;
}

function stagePaths(token: string): { ibt: string; manifest: string } {
  if (!TOKEN_PATTERN.test(token)) {
    throw new IbtImportError("Invalid staged IBT token");
  }
  const root = stageDir();
  return {
    ibt: join(root, `${token}.ibt`),
    manifest: join(root, `${token}.json`),
  };
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

function removeStage(token: string): void {
  const paths = stagePaths(token);
  removeIfPresent(paths.ibt);
  removeIfPresent(paths.manifest);
}

function cleanupExpiredStages(): void {
  const root = stageDir();
  const cutoff = Date.now() - STAGE_TTL_MS;
  for (const name of readdirSync(root)) {
    const suffix = name.endsWith(".json")
      ? ".json"
      : name.endsWith(".ibt")
        ? ".ibt"
        : null;
    if (!suffix) continue;
    const token = name.slice(0, -suffix.length);
    if (!TOKEN_PATTERN.test(token)) continue;
    const stagedPath = join(root, name);
    try {
      if (statSync(stagedPath).mtimeMs < cutoff) removeStage(token);
    } catch {
      removeStage(token);
    }
  }
}

export async function stageIbtUpload(
  body: ReadableStream<Uint8Array> | null,
  fileName: string,
  declaredBytes?: number,
): Promise<{ token: string | null; preview: IbtImportPreview }> {
  cleanupExpiredStages();
  if (!body) throw new IbtImportError("Missing IBT request body");
  if (
    declaredBytes !== undefined &&
    (!Number.isSafeInteger(declaredBytes) ||
      declaredBytes <= 0 ||
      declaredBytes > MAX_IBT_BYTES)
  ) {
    throw new IbtImportError(
      `IBT upload exceeds the ${MAX_IBT_BYTES / 1024 ** 3} GiB limit`,
      413,
    );
  }

  const token = randomUUID();
  const paths = stagePaths(token);
  const file = await openFile(paths.ibt, "wx");
  const reader = body.getReader();
  let bytesWritten = 0;
  let uploadFailure: unknown;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesWritten += value.byteLength;
      if (bytesWritten > MAX_IBT_BYTES) {
        throw new IbtImportError(
          `IBT upload exceeds the ${MAX_IBT_BYTES / 1024 ** 3} GiB limit`,
          413,
        );
      }
      let offset = 0;
      while (offset < value.byteLength) {
        const result = await file.write(value, offset, value.byteLength - offset);
        if (result.bytesWritten === 0) {
          throw new IbtImportError("IBT staging write stopped unexpectedly");
        }
        offset += result.bytesWritten;
      }
    }
  } catch (error) {
    uploadFailure = error;
  } finally {
    await file.close();
    reader.releaseLock();
  }
  if (uploadFailure) {
    removeIfPresent(paths.ibt);
    throw uploadFailure;
  }

  if (bytesWritten === 0) {
    removeIfPresent(paths.ibt);
    throw new IbtImportError("The uploaded IBT file is empty");
  }
  if (declaredBytes !== undefined && bytesWritten !== declaredBytes) {
    removeIfPresent(paths.ibt);
    throw new IbtImportError(
      `Incomplete IBT upload: expected ${declaredBytes} bytes, received ${bytesWritten}`,
    );
  }

  try {
    const preview = await previewIbtFile(paths.ibt, fileName);
    if (!preview.canImport) {
      removeIfPresent(paths.ibt);
      return { token: null, preview };
    }
    const manifest: StagedIbtManifest = {
      version: 1,
      createdAt: Date.now(),
      preview,
    };
    writeFileSync(paths.manifest, JSON.stringify(manifest));
    return { token, preview };
  } catch (error) {
    removeIfPresent(paths.ibt);
    removeIfPresent(paths.manifest);
    throw error;
  }
}

function loadManifest(token: string): {
  paths: { ibt: string; manifest: string };
  manifest: StagedIbtManifest;
} {
  cleanupExpiredStages();
  const paths = stagePaths(token);
  if (!existsSync(paths.ibt) || !existsSync(paths.manifest)) {
    throw new IbtImportError(
      "This IBT preview has expired or was already used",
      410,
    );
  }

  let manifest: StagedIbtManifest;
  try {
    manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as StagedIbtManifest;
  } catch {
    removeStage(token);
    throw new IbtImportError("The staged IBT manifest is invalid", 410);
  }
  if (
    manifest.version !== 1 ||
    !manifest.preview?.canImport ||
    Date.now() - manifest.createdAt > STAGE_TTL_MS
  ) {
    removeStage(token);
    throw new IbtImportError("This IBT preview has expired", 410);
  }
  if (statSync(paths.ibt).size !== manifest.preview.fileSize) {
    removeStage(token);
    throw new IbtImportError("The staged IBT file changed after preview", 410);
  }
  return { paths, manifest };
}

export async function commitStagedIbt(
  token: string,
  ownership: SessionOwnership = "mine",
): Promise<{
  packetCount: number;
  laps: ImportSessionResult["laps"];
  preview: IbtImportPreview;
}> {
  const { paths, manifest } = loadManifest(token);
  try {
    try {
      await registerImportedIRacingIdentity(manifest.preview);
      const result = await importSessionFrames(
        ibtFrames(paths.ibt, manifest.preview),
        "iracing",
        { requireLaps: true, ownership },
      );
      return {
        packetCount: result.packetCount,
        laps: result.laps,
        preview: manifest.preview,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "No complete, importable laps were found"
      ) {
        throw new IbtImportError(error.message);
      }
      throw error;
    }
  } finally {
    removeStage(token);
  }
}

export function cancelStagedIbt(token: string): void {
  removeStage(token);
}
