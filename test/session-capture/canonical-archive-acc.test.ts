import { afterEach, describe, expect, test } from "bun:test";
import { eq, inArray } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { db } from "../../server/db/index";
import { canonicalArchives, sessions } from "../../server/db/schema";
import { deleteSession } from "../../server/db/session-queries";
import { detectGameIdFromBuffer } from "../../server/session-capture/import-capture";
import { assertCanonicalArchiveGameContract } from "../support/session-capture/canonical-archive-game-contract";

initGameAdapters();
initServerGameAdapters();

const ACC_CAPTURE = "test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz";
const createdSessionIds: number[] = [];
const tempDirs: string[] = [];

async function cleanCapturedSessions(): Promise<void> {
  const sessionIds = createdSessionIds.splice(0);
  if (sessionIds.length > 0) {
    const archives = await db
      .select({ archivePath: canonicalArchives.archivePath })
      .from(canonicalArchives)
      .where(inArray(canonicalArchives.sessionId, sessionIds))
      .all();

    for (const sessionId of sessionIds) await deleteSession(sessionId);
    for (const archive of archives) rmSync(dirname(archive.archivePath), { recursive: true, force: true });
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
}

async function seedAccCapture(): Promise<{ sessionId: number; rawFile: string }> {
  const dir = mkdtempSync(join(process.cwd(), ".data-archive-acc-test-"));
  tempDirs.push(dir);
  const rawFile = join(dir, basename(ACC_CAPTURE));
  const capture = Buffer.from(await Bun.file(ACC_CAPTURE).arrayBuffer());
  expect(detectGameIdFromBuffer(capture)).toBe("acc");
  await Bun.write(rawFile, capture);

  const [session] = await db.insert(sessions).values({
    carOrdinal: 1,
    trackOrdinal: 1,
    gameId: "acc",
    sessionType: "practice",
    rawFile,
    source: "native-live",
  }).returning({ id: sessions.id });
  createdSessionIds.push(session.id);
  return { sessionId: session.id, rawFile };
}

afterEach(cleanCapturedSessions);

describe("canonical archive ACC contract", () => {
  test("builds verified canonical archive from committed ACC raw evidence", async () => {
    const seeded = await seedAccCapture();

    await assertCanonicalArchiveGameContract({
      sessionId: seeded.sessionId,
      gameId: "acc",
      rawFile: seeded.rawFile,
    });
  }, 120_000);
});
