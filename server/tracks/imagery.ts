import { createHash } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { GameId } from "../../shared/games/ids";
import { USER_TRACKS_DIR } from "../../shared/platform/runtime/data-paths";

const TRACK_IMAGERY_DIR = join(USER_TRACKS_DIR, "imagery");
const MAX_IMAGE_DIMENSION = 2560;
const imageUrlByPath = new Map<string, string | null>();

export function getBaseTrackImagePath(gameId: GameId, baseTrackName: string): string {
  const identity = `${gameId}\0${baseTrackName.trim().normalize("NFKC").toLocaleLowerCase()}`;
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return join(TRACK_IMAGERY_DIR, `${gameId}-${digest}.webp`);
}

export function getBaseTrackImageUrl(gameId: GameId, baseTrackName: string): string | null {
  const path = getBaseTrackImagePath(gameId, baseTrackName);
  const cached = imageUrlByPath.get(path);
  if (cached !== undefined) return cached;

  try {
    const modifiedAt = Math.trunc(statSync(path).mtimeMs);
    const url = `/api/track-base-image?gameId=${encodeURIComponent(gameId)}&baseTrackName=${encodeURIComponent(baseTrackName)}&v=${modifiedAt}`;
    imageUrlByPath.set(path, url);
    return url;
  } catch {
    imageUrlByPath.set(path, null);
    return null;
  }
}

export async function saveBaseTrackImage(gameId: GameId, baseTrackName: string, input: ArrayBuffer): Promise<string> {
  const image = await sharp(input, { failOn: "error", limitInputPixels: 40_000_000 })
    .rotate()
    .resize({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 88 })
    .toBuffer();

  mkdirSync(TRACK_IMAGERY_DIR, { recursive: true });
  const path = getBaseTrackImagePath(gameId, baseTrackName);
  await Bun.write(path, image);
  imageUrlByPath.delete(path);
  return getBaseTrackImageUrl(gameId, baseTrackName)!;
}
