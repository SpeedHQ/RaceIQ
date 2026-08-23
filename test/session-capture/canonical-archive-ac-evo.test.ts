import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { eq } from "drizzle-orm";

import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { getServerGame } from "../../server/games/registry";
import { META_FRAME_MAGIC } from "../../server/session-capture/framing";
import { db } from "../../server/db";
import { canonicalArchives, sessions } from "../../server/db/schema";
import { assertCanonicalArchiveGameContract } from "../support/session-capture/canonical-archive-game-contract";

initGameAdapters();
initServerGameAdapters();

const FIXTURE = "test/artifacts/sessions/session-ac-evo-mid-2026-04-21T20-24-34-810Z.bin.gz";

function firstParsedPacket() {
  const raw = Buffer.from(gunzipSync(readFileSync(FIXTURE)));
  const metadataLength = raw.readUInt32LE(4);
  if (raw.readUInt32LE(0) !== META_FRAME_MAGIC || metadataLength !== 4) {
    throw new Error("AC Evo fixture is not RaceIQ-framed recorder evidence");
  }

  const game = getServerGame("ac-evo");
  const state = game.createParserState?.() ?? null;
  let offset = 8 + metadataLength;
  while (offset + 4 <= raw.length) {
    const frameLength = raw.readUInt32LE(offset);
    offset += 4;
    if (frameLength === 0 || offset + frameLength > raw.length) break;
    const packet = game.tryParse(raw.subarray(offset, offset + frameLength), state);
    offset += frameLength;
    if (packet) return packet;
  }
  throw new Error("AC Evo fixture contains no packet accepted by production adapter");
}

async function cleanupCapture(sessionId: number, rawFile: string, tempDir: string): Promise<void> {
  const archive = await db
    .select({ archivePath: canonicalArchives.archivePath })
    .from(canonicalArchives)
    .where(eq(canonicalArchives.sessionId, sessionId))
    .get();
  await db.delete(sessions).where(eq(sessions.id, sessionId)).run();
  if (archive?.archivePath) rmSync(dirname(archive.archivePath), { recursive: true, force: true });
  rmSync(rawFile, { force: true });
  rmSync(tempDir, { recursive: true, force: true });
}

describe("AC Evo canonical archive contract", () => {
  test("builds verified archive from recorder-framed AC Evo evidence", async () => {
    expect(firstParsedPacket().gameId).toBe("ac-evo");

    const tempDir = mkdtempSync(join(tmpdir(), "raceiq-ac-evo-canonical-archive-"));
    const rawFile = join(tempDir, basename(FIXTURE));
    copyFileSync(FIXTURE, rawFile);
    const [session] = await db.insert(sessions).values({
      carOrdinal: 1,
      trackOrdinal: 1,
      gameId: "ac-evo",
      sessionType: "practice",
      rawFile,
      source: "native-live",
    }).returning({ id: sessions.id });

    try {
      await assertCanonicalArchiveGameContract({
        sessionId: session.id,
        gameId: "ac-evo",
        rawFile,
      });
    } finally {
      await cleanupCapture(session.id, rawFile, tempDir);
    }
  }, 120_000);
});
