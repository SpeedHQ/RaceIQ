import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildTrackRegistryArtifacts,
  loadTrackRegistrySource,
  readTrackRegistryProjection,
  recoverTrackRegistrySourceUpdate,
  renderTrackRegistrySource,
  resolveTrackRegistryLocations,
} from "../../shared/racing/tracks/registry-source";

const CHECK = process.argv.slice(2).includes("--check");
const SOURCE_FILES = [
  "configurations.json",
  "facts.json",
  "geometry.json",
  "verification.json",
] as const;

function readText(path: string): string {
  return readFileSync(path, "utf8");
}

function checkRegistry(): void {
  const locations = resolveTrackRegistryLocations();
  if (existsSync(locations.transactionPath)) {
    throw new Error(`Pending track registry source update ${locations.transactionPath}; run bun run tracks:registry`);
  }

  const source = loadTrackRegistrySource(locations);
  const rendered = renderTrackRegistrySource(source);
  for (const filename of SOURCE_FILES) {
    const path = resolve(locations.sourceDirectory, filename);
    if (readText(path) !== rendered.get(filename)) {
      throw new Error(`Non-canonical track registry source ${path}; run bun run tracks:registry`);
    }
  }

  const nonce = randomBytes(8).toString("hex");
  const first = {
    sourceDirectory: locations.sourceDirectory,
    databasePath: `${locations.databasePath}.check-${nonce}-1.tmp`,
    reportPath: `${locations.reportPath}.check-${nonce}-1.tmp`,
    transactionPath: `${locations.transactionPath}.check-${nonce}-1.tmp`,
  };
  const second = {
    sourceDirectory: locations.sourceDirectory,
    databasePath: `${locations.databasePath}.check-${nonce}-2.tmp`,
    reportPath: `${locations.reportPath}.check-${nonce}-2.tmp`,
    transactionPath: `${locations.transactionPath}.check-${nonce}-2.tmp`,
  };

  try {
    const firstBuild = buildTrackRegistryArtifacts(source, first);
    const secondBuild = buildTrackRegistryArtifacts(source, second);
    if (JSON.stringify(firstBuild.projection) !== JSON.stringify(secondBuild.projection)
      || firstBuild.report !== secondBuild.report) {
      throw new Error("Nondeterministic generated track registry artifacts");
    }

    let committedProjection;
    try {
      committedProjection = readTrackRegistryProjection(locations.databasePath);
    } catch {
      throw new Error("Stale generated track registry; run bun run tracks:registry");
    }
    if (JSON.stringify(committedProjection) !== JSON.stringify(firstBuild.projection)) {
      throw new Error("Stale generated track registry; run bun run tracks:registry");
    }

    let committedReport: string;
    try {
      committedReport = readText(locations.reportPath);
    } catch {
      throw new Error("Stale track registry report; run bun run tracks:registry");
    }
    if (committedReport !== firstBuild.report) {
      throw new Error("Stale track registry report; run bun run tracks:registry");
    }
  } finally {
    for (const path of [
      first.databasePath,
      first.reportPath,
      first.transactionPath,
      second.databasePath,
      second.reportPath,
      second.transactionPath,
    ]) {
      rmSync(path, { force: true });
      rmSync(`${path}-shm`, { force: true });
      rmSync(`${path}-wal`, { force: true });
    }
  }

  console.log("Track registry artifacts are current and deterministic.");
}

function buildRegistry(): void {
  const locations = resolveTrackRegistryLocations();
  recoverTrackRegistrySourceUpdate(locations);
  const source = loadTrackRegistrySource(locations);
  const rendered = renderTrackRegistrySource(source);
  for (const filename of SOURCE_FILES) {
    const path = resolve(locations.sourceDirectory, filename);
    const body = rendered.get(filename);
    if (body === undefined) throw new Error(`Missing rendered source ${filename}`);
    if (!existsSync(path) || readText(path) !== body) writeFileSync(path, body, "utf8");
  }
  const { sourceHash, projection } = buildTrackRegistryArtifacts(source, locations);
  console.log(
    `Built track registry ${sourceHash.slice(0, 12)}: `
    + `${projection.venueNodes.length} venues, ${projection.layouts.length} layouts, `
    + `${projection.assignments.length} assignments, ${projection.facts.length} facts, `
    + `${projection.geometry.length} geometry rows.`,
  );
}

if (CHECK) checkRegistry();
else buildRegistry();
