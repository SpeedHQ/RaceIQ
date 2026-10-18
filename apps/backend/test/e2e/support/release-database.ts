import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import { encodeMetaFrame, iterateSessionCaptureRecords } from "@raceiq/capture-formats/session/framing";
import { ROOT, command, upgradeEnvironment } from "./upgrade-server";
import Database from "libsql";


export const CLASSIFICATION_BASELINE = "v0.19.2";

export interface ReleaseFixture {
  gameId: string;
  paths: string[];
}

/** Build historical rows through the pinned release's real parser and storage path. */
export async function seedReleaseDatabase(temporary: string, source?: ReleaseFixture) {
  const releaseDir = join(temporary, "release");
  const dataDir = join(temporary, "data");
  mkdirSync(releaseDir);
  mkdirSync(dataDir);
  await command(["git", "rev-parse", "--verify", `${CLASSIFICATION_BASELINE}^{commit}`]);
  const archive = join(temporary, "release.tar");
  await command(["git", "archive", "--format=tar", `--output=${archive}`, CLASSIFICATION_BASELINE]);
  await command(["tar", "-xf", archive, "-C", releaseDir, "--exclude=.claude"]);
  await command(["git", "init", "--quiet"], releaseDir);
  await command([process.execPath, "install", "--frozen-lockfile"], releaseDir);
  let paths = source?.paths;
  if (!paths) {
    const fixture = join(temporary, "ac-evo-tourist.bin.gz");
    writeFileSync(fixture, Buffer.concat([1, 2].map((part) =>
      readFileSync(join(ROOT, `test/artifacts/sessions/ac-evo-tourist-2026-10-10.bin.gz.part${part}`)),
    )));
    paths = [fixture];
  }
  await command([process.execPath, "run", "db:seed", `--games=${source?.gameId ?? "ac-evo"}`, `--fixtures=${paths.join(",")}`], releaseDir, upgradeEnvironment(dataDir));
  return { releaseDir, dataDir };
}

/** Create captured ACC data ending after third-lap trigger; avoids post-reset detector drift. */
export function createAccMigrationFixture(temporary: string): string {
  const source = gunzipSync(readFileSync(join(ROOT, "test/artifacts/sessions/acc-2026-04-23T16-42-16-158Z.bin.gz")));
  const triggerOffset = 63_967_244;
  const triggerLength = source.readUInt32LE(triggerOffset);
  const endOffset = triggerOffset + 4 + triggerLength;
  let frameCount = 0;
  for (const record of iterateSessionCaptureRecords(source)) {
    if (record.endOffset > endOffset) break;
    if (record.kind === "frame") frameCount++;
  }
  const cropped = Buffer.concat([encodeMetaFrame(frameCount), source.subarray(12, endOffset)]);
  const fixture = join(temporary, "acc-third-lap.bin.gz");
  writeFileSync(fixture, gzipSync(cropped));
  return fixture;
}

/** Prepare legacy fixture files in organized locations without upgrading legacy database schema. */
export async function prepareOrganizedReleaseData(dataDir: string): Promise<void> {
  const database = new Database(join(dataDir, "app.db"));
  try {
    const sessions = database.prepare("SELECT DISTINCT game_id,ownership,raw_file FROM sessions WHERE raw_file IS NOT NULL")
      .all() as Array<{ game_id: string; ownership: string | null; raw_file: string }>;
    const recordingDirectory = join(dataDir, "sessions");
    for (const session of sessions) {
      const owner = session.ownership === "others" ? "others" : "own";
      const destination = join(recordingDirectory, session.game_id, owner, basename(session.raw_file));
      if (destination !== session.raw_file) {
        mkdirSync(dirname(destination), { recursive: true });
        renameSync(session.raw_file, destination);
        database.prepare("UPDATE sessions SET raw_file=? WHERE raw_file=?").run(destination, session.raw_file);
      }
    }
    const settingsPath = join(dataDir, "settings.json");
    const settings = await Bun.file(settingsPath).json();
    await Bun.write(settingsPath, JSON.stringify({ ...settings, recordingDirectory }));
  } finally {
    database.close();
  }
}
