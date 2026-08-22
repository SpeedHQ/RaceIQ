import { afterAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { initGameAdapters } from "../../shared/games/init";
import { LOCAL_PLAYER_EVIDENCE } from "../../shared/racing/quality/contracts";
import { initServerGameAdapters } from "../../server/games/init";
import { readIRacingFrames } from "../../server/games/iracing/recorder";
import { deleteSession } from "../../server/db/session-queries";
import { db } from "../../server/db";
import { sessions } from "../../server/db/schema";
import { currentTelemetryVersionIdentity } from "../../server/telemetry/version-identity";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { importSessionFrames } from "../../server/session-capture/import-pipeline";
import { readSessionPackets } from "../support/recordings/session-frames";
import { assertCanonicalArchiveGameContract } from "../support/session-capture/canonical-archive-game-contract";

const FIXTURE = resolve(import.meta.dir, "../artifacts/sessions/iracing-road-america-gt3.bin.gz");

initGameAdapters();
initServerGameAdapters();

afterAll(() => stopMaintenanceTasks());

describe("iRacing canonical archive", () => {
  test(
    "builds verified canonical archive from production RaceIQ session recording",
    async () => {
      const createdSessionIds: number[] = [];
      const archiveDirectories = new Set<string>();
      try {
        const imported = await importSessionFrames(readIRacingFrames(FIXTURE), "iracing", {
          requireLaps: true,
          sourceKind: "raceiq-raw",
          participant: LOCAL_PLAYER_EVIDENCE,
          versionIdentity: currentTelemetryVersionIdentity("iracing"),
          sourceArchiveVerification: {
            state: "verified",
            sourceGeneration: "sha256:iracing-canonical-archive-contract-source",
          },
        });
        expect(imported.sessionIds).toHaveLength(1);
        const sessionId = imported.sessionIds[0]!;
        createdSessionIds.push(sessionId);

        const session = await db.select({ rawFile: sessions.rawFile }).from(sessions).where(eq(sessions.id, sessionId)).get();
        if (!session?.rawFile) throw new Error("iRacing import did not create a RaceIQ session recording");

        expect(readSessionPackets(session.rawFile, "iracing")).toHaveLength(imported.packetCount);

        const { archive } = await assertCanonicalArchiveGameContract({
          sessionId,
          gameId: "iracing",
          rawFile: session.rawFile,
        });
        archiveDirectories.add(dirname(dirname(archive.archivePath)));
      } finally {
        for (const sessionId of createdSessionIds) await deleteSession(sessionId);
        for (const directory of archiveDirectories) {
          rmSync(directory, { recursive: true, force: true });
        }
      }
    },
    { timeout: 120_000 },
  );
});
