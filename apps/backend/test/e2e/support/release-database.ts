import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, command, upgradeEnvironment } from "./upgrade-server";

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
