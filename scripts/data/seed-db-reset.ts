import { existsSync, unlinkSync } from "node:fs";
import { eq, inArray, like } from "drizzle-orm";
import { db } from "../../server/db/index";
import { chatThreadId, compareChatThreadId, getChatMemory, listThreadGenerations } from "../../server/ai/chat-agent";
import { getCompareQualityIdentity, getLapQualityIdentity } from "../../server/db/analysis-queries";
import { sessions, laps, profiles, tunes, tuneAssignments, experiments, experimentVersions, experimentFocusEvents, lapAnalyses, compareAnalyses } from "../../server/db/schema";
import { deleteSession } from "../../server/db/session-queries";
import { PROFILE_NAME, SEED_MARKER } from "./seed-db-options";

export async function removeSeedData(): Promise<void> {
  const sessionRows = await db
    .select({ id: sessions.id, rawFile: sessions.rawFile })
    .from(sessions)
    .where(like(sessions.notes, `%${SEED_MARKER}%`))
    .all();
  const seededLaps = sessionRows.length
    ? await db
        .select({ id: laps.id, gameId: sessions.gameId })
        .from(laps)
        .innerJoin(sessions, eq(laps.sessionId, sessions.id))
        .where(
          inArray(
            sessions.id,
            sessionRows.map((row) => row.id),
          ),
        )
        .all()
    : [];
  const experimentRows = await db
    .select({ id: experiments.id })
    .from(experiments)
    .where(like(experiments.notes, `%${SEED_MARKER}%`))
    .all();
  const tuneRows = await db.select({ id: tunes.id }).from(tunes).where(eq(tunes.source, SEED_MARKER)).all();
  const chatBases: string[] = [];
  for (const lap of seededLaps) {
    const identity = await getLapQualityIdentity(lap.id);
    if (identity) chatBases.push(chatThreadId(lap.id, `${identity.policyVersion}:${identity.generation}`));
  }
  const fmLapIds = seededLaps
    .filter((lap) => lap.gameId === "fm-2023")
    .map((lap) => lap.id)
    .sort((a, b) => a - b);
  if (fmLapIds.length >= 2) {
    const latestFmLapId = fmLapIds[fmLapIds.length - 1];
    if (latestFmLapId !== undefined) {
      const identity = await getCompareQualityIdentity(latestFmLapId, fmLapIds[0]);
      if (identity) chatBases.push(compareChatThreadId(latestFmLapId, fmLapIds[0], `${identity.policyVersion}:${identity.generation}`));
    }
  }
  if (chatBases.length > 0) {
    const memory = getChatMemory();
    for (const base of chatBases) {
      const threadIds = new Set((await listThreadGenerations(base)).map((generation) => generation.threadId));
      threadIds.add(base);
      for (const threadId of threadIds) await memory.deleteThread(threadId);
    }
  }

  if (experimentRows.length) {
    await db
      .delete(experimentFocusEvents)
      .where(
        inArray(
          experimentFocusEvents.experimentId,
          experimentRows.map((row) => row.id),
        ),
      )
      .run();
    await db
      .delete(experimentVersions)
      .where(
        inArray(
          experimentVersions.experimentId,
          experimentRows.map((row) => row.id),
        ),
      )
      .run();
    await db
      .delete(experiments)
      .where(
        inArray(
          experiments.id,
          experimentRows.map((row) => row.id),
        ),
      )
      .run();
  }
  if (tuneRows.length) {
    await db
      .delete(tuneAssignments)
      .where(
        inArray(
          tuneAssignments.tuneId,
          tuneRows.map((row) => row.id),
        ),
      )
      .run();
    await db
      .delete(tunes)
      .where(
        inArray(
          tunes.id,
          tuneRows.map((row) => row.id),
        ),
      )
      .run();
  }
  for (const row of sessionRows) {
    await deleteSession(row.id);
    if (row.rawFile && existsSync(row.rawFile)) unlinkSync(row.rawFile);
  }
  const seedProfile = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.name, PROFILE_NAME)).all();
  if (seedProfile.length)
    await db
      .delete(profiles)
      .where(
        inArray(
          profiles.id,
          seedProfile.map((row) => row.id),
        ),
      )
      .run();
  await db
    .delete(lapAnalyses)
    .where(like(lapAnalyses.analysis, `%${SEED_MARKER}%`))
    .run();
  await db
    .delete(compareAnalyses)
    .where(like(compareAnalyses.analysis, `%${SEED_MARKER}%`))
    .run();
}
