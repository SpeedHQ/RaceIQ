import { createHash, randomBytes } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { TrackImageryArtifact } from "../../shared/racing/tracks/imagery";
import { USER_TRACKS_DIR } from "../../shared/platform/runtime/data-paths";

const TRACK_IMAGERY_ARTIFACT_CACHE = resolve(USER_TRACKS_DIR, "track-imagery-artifacts");
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

type TrackImageryArtifactFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface VerifiedFile {
  modifiedAtMs: number;
  sizeBytes: number;
}

interface ResolveTrackImageryPackOptions {
  cacheDirectory?: string;
  fetcher?: TrackImageryArtifactFetcher;
}

const verifiedFiles = new Map<string, VerifiedFile>();
const pendingArtifacts = new Map<string, Promise<string>>();

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function verifyArtifactFile(path: string, artifact: TrackImageryArtifact): Promise<boolean> {
  if (!existsSync(path)) return false;
  const stat = statSync(path);
  if (!stat.isFile() || stat.size !== artifact.sizeBytes) return false;

  const cacheKey = `${path}\0${artifact.sha256}`;
  const verified = verifiedFiles.get(cacheKey);
  if (verified?.modifiedAtMs === stat.mtimeMs && verified.sizeBytes === stat.size) return true;
  if ((await sha256File(path)) !== artifact.sha256) return false;

  verifiedFiles.set(cacheKey, { modifiedAtMs: stat.mtimeMs, sizeBytes: stat.size });
  return true;
}

async function downloadArtifact(artifact: TrackImageryArtifact, cacheDirectory: string, fetcher: TrackImageryArtifactFetcher): Promise<string> {
  mkdirSync(cacheDirectory, { recursive: true });
  const cachePath = resolve(cacheDirectory, `${artifact.sha256}.rqi`);
  if (await verifyArtifactFile(cachePath, artifact)) return cachePath;
  rmSync(cachePath, { force: true });

  const response = await fetcher(artifact.url, {
    headers: { Accept: "application/octet-stream" },
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Track imagery artifact ${artifact.version} returned HTTP ${response.status}`);

  const temporaryPath = `${cachePath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const temporaryVerificationKey = `${temporaryPath}\0${artifact.sha256}`;
  try {
    const sizeBytes = await Bun.write(temporaryPath, response);
    if (sizeBytes !== artifact.sizeBytes) {
      throw new Error(`Track imagery artifact ${artifact.version} size mismatch: expected ${artifact.sizeBytes}, received ${sizeBytes}`);
    }
    if (!(await verifyArtifactFile(temporaryPath, artifact))) {
      throw new Error(`Track imagery artifact ${artifact.version} SHA-256 mismatch`);
    }
    try {
      renameSync(temporaryPath, cachePath);
    } catch (error) {
      if (await verifyArtifactFile(cachePath, artifact)) return cachePath;
      throw error;
    }
    const stat = statSync(cachePath);
    verifiedFiles.set(`${cachePath}\0${artifact.sha256}`, { modifiedAtMs: stat.mtimeMs, sizeBytes: stat.size });
    return cachePath;
  } finally {
    verifiedFiles.delete(temporaryVerificationKey);
    rmSync(temporaryPath, { force: true });
  }
}

/** Resolve verified local imagery pack, downloading and atomically caching declared artifact when needed. */
export async function resolveTrackImageryPackPath(localPath: string, artifact?: TrackImageryArtifact, options: ResolveTrackImageryPackOptions = {}): Promise<string> {
  if (!artifact) {
    if (!existsSync(localPath)) throw new Error(`Missing track imagery package ${localPath}`);
    return localPath;
  }
  if (await verifyArtifactFile(localPath, artifact)) return localPath;

  const cacheDirectory = options.cacheDirectory ?? TRACK_IMAGERY_ARTIFACT_CACHE;
  const pendingKey = `${cacheDirectory}\0${artifact.sha256}`;
  const existing = pendingArtifacts.get(pendingKey);
  if (existing) return existing;

  const pending = downloadArtifact(artifact, cacheDirectory, options.fetcher ?? fetch);
  pendingArtifacts.set(pendingKey, pending);
  try {
    return await pending;
  } finally {
    if (pendingArtifacts.get(pendingKey) === pending) pendingArtifacts.delete(pendingKey);
  }
}
