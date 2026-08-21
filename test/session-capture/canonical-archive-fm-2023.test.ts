import { afterEach, describe, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { inArray } from "drizzle-orm";
import { initGameAdapters } from "../../shared/games/init";
import { initServerGameAdapters } from "../../server/games/init";
import { db } from "../../server/db/index";
import { canonicalArchives, sessions } from "../../server/db/schema";
import { assertCanonicalArchiveGameContract } from "../support/session-capture/canonical-archive-game-contract";

const FM_2023_CAPTURE = "test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz";
const sessionIds: number[] = [];
const tempDirs: string[] = [];

initGameAdapters();
initServerGameAdapters();

afterEach(async () => {
  const ids = sessionIds.splice(0);
  if (ids.length > 0) {
    const archives = await db.select({ archivePath: canonicalArchives.archivePath })
      .from(canonicalArchives)
      .where(inArray(canonicalArchives.sessionId, ids))
      .all();
    await db.delete(sessions).where(inArray(sessions.id, ids)).run();
    for (const archive of archives) rmSync(dirname(archive.archivePath), { recursive: true, force: true });
  }
  for (const tempDir of tempDirs.splice(0)) rmSync(tempDir, { recursive: true, force: true });
});

describe("FM 2023 canonical archive", () => {
  test("builds verified canonical archive from committed recorder capture", async () => {
    const tempDir = mkdtempSync(join(process.cwd(), ".data-fm-2023-canonical-archive-test-"));
    tempDirs.push(tempDir);
    const rawFile = join(tempDir, basename(FM_2023_CAPTURE));
    await Bun.write(rawFile, Buffer.from(await Bun.file(FM_2023_CAPTURE).arrayBuffer()));

    const [session] = await db.insert(sessions).values({
      carOrdinal: 1,
      trackOrdinal: 1,
      gameId: "fm-2023",
      sessionType: "practice",
      rawFile,
      source: "native-live",
    }).returning({ id: sessions.id });
    sessionIds.push(session.id);
    await assertCanonicalArchiveGameContract({
      sessionId: session.id,
      gameId: "fm-2023",
      rawFile,
    });
  }, 120_000);
});
