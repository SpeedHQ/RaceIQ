/**
 * Background session compressor.
 *
 * Runs every 5 minutes. While no session is actively recording, finds session
 * .bin files older than 24 hours and gzips them in-place, updating the DB path
 * to .bin.gz. Skips if a session is active to avoid competing with live writes.
 */
import { unlinkSync } from "fs";
import { gzip } from "zlib";
import { promisify } from "util";

const gzipAsync = promisify(gzip);
import { getUncompressedSessions, updateSessionRawFile } from "./db/queries";
import { isSessionActive } from "./pipeline";
import { db } from "./db/index";
import { sessions } from "./db/schema";
import { eq } from "drizzle-orm";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = 5 * 60 * 1000;

async function compressSession(id: number, binPath: string): Promise<void> {
  const gzPath = binPath + ".gz";
  const data = await Bun.file(binPath).arrayBuffer();
  const compressed = await gzipAsync(Buffer.from(data));
  await Bun.write(gzPath, compressed);

  // Fetch current lapDetectorVersion to preserve it in the update
  const row = await db
    .select({ lapDetectorVersion: sessions.lapDetectorVersion })
    .from(sessions)
    .where(eq(sessions.id, id))
    .get();

  await updateSessionRawFile(id, gzPath, row?.lapDetectorVersion ?? "");
  unlinkSync(binPath);
  console.log(`[Compressor] ${binPath} → ${gzPath} (${(data.byteLength / 1024).toFixed(0)}KB → ${(compressed.byteLength / 1024).toFixed(0)}KB)`);
}

export async function runCompressionNow(): Promise<void> {
  return runCompression();
}

async function runCompression(): Promise<void> {
  if (isSessionActive()) return;

  const candidates = await getUncompressedSessions(ONE_DAY_MS);
  if (candidates.length === 0) return;

  console.log(`[Compressor] Compressing ${candidates.length} session(s)…`);
  for (const { id, rawFile } of candidates) {
    if (isSessionActive()) break; // stop if a session starts mid-run
    try {
      const file = Bun.file(rawFile);
      if (!(await file.exists())) continue;
      await compressSession(id, rawFile);
    } catch (err) {
      console.error(`[Compressor] Failed to compress session ${id}:`, err);
    }
  }
}

let _interval: ReturnType<typeof setInterval> | null = null;

export function startSessionCompressor(): void {
  if (_interval) return;
  _interval = setInterval(() => void runCompression(), INTERVAL_MS);
}

export function stopSessionCompressor(): void {
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
}
