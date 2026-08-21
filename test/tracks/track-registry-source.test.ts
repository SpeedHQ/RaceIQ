import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import {
  assertTrackRegistryArtifactsCurrent,
  buildTrackRegistryArtifacts,
  loadTrackRegistrySource,
  readTrackRegistryProjection,
  readTrackRegistrySourceFiles,
  recoverTrackRegistrySourceUpdate,
  renderTrackRegistrySource,
  TRACK_REGISTRY_SOURCE_VERSION,
  type TrackRegistryLocations,
  type TrackRegistrySource,
  updateTrackRegistrySource,
} from "../../shared/racing/tracks/registry-source";
import { closeTrackRegistry } from "../../shared/racing/tracks/registry";

type ArtifactSnapshot = { source: Record<string, string>; database: string; report: string };

function makeWorkspace(): { root: string; locations: TrackRegistryLocations } {
  const root = mkdtempSync(join(tmpdir(), "raceiq-track-registry-"));
  return {
    root,
    locations: {
      sourceDirectory: resolve(root, "registry-source"),
      databasePath: resolve(root, "registry.sqlite"),
      reportPath: resolve(root, "registry-report.json"),
      transactionPath: resolve(root, ".registry-source-update.json"),
    },
  };
}

function withWorkspace<T>(run: (locations: TrackRegistryLocations) => T): T {
  const { root, locations } = makeWorkspace();
  closeTrackRegistry();
  try {
    return run(locations);
  } finally {
    closeTrackRegistry();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function shardPath(locations: TrackRegistryLocations, relativePath: string): string {
  return resolve(dirname(locations.sourceDirectory), relativePath);
}

function writeFiles(locations: TrackRegistryLocations, files: ReadonlyMap<string, string>): void {
  for (const [relativePath, contents] of files) {
    const path = shardPath(locations, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents, "utf8");
  }
}

function writeSource(locations: TrackRegistryLocations, source: TrackRegistrySource): void {
  writeFiles(locations, renderTrackRegistrySource(source));
}

function sourceSnapshot(locations: TrackRegistryLocations): Record<string, string> {
  return Object.fromEntries(readTrackRegistrySourceFiles(locations));
}

function sourceHash(source: TrackRegistrySource): string {
  const hash = createHash("sha256");
  for (const [relativePath, contents] of [...renderTrackRegistrySource(source)].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(relativePath).update("\0").update(contents);
  }
  return hash.digest("hex");
}

function artifactSnapshot(locations: TrackRegistryLocations): ArtifactSnapshot {
  return {
    source: sourceSnapshot(locations),
    database: readFileSync(locations.databasePath).toString("base64"),
    report: readFileSync(locations.reportPath, "utf8"),
  };
}

function baseSource(): TrackRegistrySource {
  return {
    configurations: {
      version: TRACK_REGISTRY_SOURCE_VERSION,
      venues: [
        {
          id: "alpha",
          name: "Alpha",
          metadata: {
            venueType: "real",
            location: "Test City, Test Region",
            country: "Testland",
            latitude: 12.5,
            longitude: -45.25,
            timeZone: "Etc/UTC",
            source: { gameId: "iracing", trackOrdinal: 1 },
          },
        },
        { id: "alpha/2010", name: "2010" },
        { id: "alpha/historical", name: "Historical" },
        { id: "alpha/historical/2011", name: "2011" },
      ],
      layouts: [
        { id: "alpha/2010/legacy", name: "Legacy" },
        { id: "alpha/historical/2011/nested", name: "Nested" },
        { id: "alpha/main", name: "Main", factsSlug: "oval-main" },
      ],
      assignments: [
        { gameId: "fm-2023", trackOrdinal: 0, layoutId: "alpha/main", confirmation: null },
        { gameId: "iracing", trackOrdinal: 1, layoutId: "alpha/main", confirmation: null },
      ],
    },
    facts: {
      version: TRACK_REGISTRY_SOURCE_VERSION,
      facts: [{
        slug: "oval-main",
        track: "alpha",
        layout: "oval",
        layoutName: "Oval",
        name: "Alpha Oval Main",
        corners: [{ number: 1, name: "Juncão", covers: [2, 3], direction: "left" }, { number: 4, name: "Turn 4", direction: "right" }],
        straights: [{ after: 1, name: "Start Line", group: "pit" }, { after: 4, name: "Finishing Straight" }],
      }],
    },
    geometry: {
      version: TRACK_REGISTRY_SOURCE_VERSION,
      geometry: [{
        factsSlug: "oval-main",
        gameId: "iracing",
        sectors: { s1End: 0.35, s2End: 0.75, source: "editor" },
        segments: [{ key: "t1", startFrac: 0, endFrac: 0.5 }, { key: "s1", startFrac: 0.5, endFrac: 1 }],
      }],
    },
    verification: {
      version: TRACK_REGISTRY_SOURCE_VERSION,
      entries: {
        "meta:oval-main": { hash: "meta-v1", date: "2026-01-01", by: "test" },
        "segments:iracing/oval-main": { hash: "segments-v1", date: "2026-01-02" },
      },
    },
  };
}

function writeRecoveryJournal(locations: TrackRegistryLocations, oldSource: TrackRegistrySource, nextSource: TrackRegistrySource): void {
  const oldFiles = renderTrackRegistrySource(oldSource);
  const nextFiles = renderTrackRegistrySource(nextSource);
  const sourceBackups: Record<string, string> = {};
  const sourceStaged: Record<string, string> = {};
  for (const [relativePath, contents] of oldFiles) {
    const backup = `${shardPath(locations, relativePath)}.backup.recovery`;
    mkdirSync(dirname(backup), { recursive: true });
    writeFileSync(backup, contents, "utf8");
    sourceBackups[relativePath] = backup;
  }
  for (const [relativePath, contents] of nextFiles) {
    const staged = `${shardPath(locations, relativePath)}.stage.recovery`;
    mkdirSync(dirname(staged), { recursive: true });
    writeFileSync(staged, contents, "utf8");
    sourceStaged[relativePath] = staged;
  }
  writeFileSync(locations.transactionPath, `${JSON.stringify({
    version: 1,
    oldSourceHash: sourceHash(oldSource),
    newSourceHash: sourceHash(nextSource),
    sourceBackups,
    sourceStaged,
    databaseBackup: `${locations.databasePath}.backup`,
    databaseStaged: `${locations.databasePath}.stage`,
    reportBackup: `${locations.reportPath}.backup`,
    reportStaged: `${locations.reportPath}.stage`,
  }, null, 2)}\n`, "utf8");
}

describe("track registry venue metadata source", () => {
  test("loads, renders, and hashes venue shards deterministically", () => {
    withWorkspace((locations) => {
      const source = baseSource();
      writeSource(locations, source);
      const loaded = loadTrackRegistrySource(locations);
      const rendered = renderTrackRegistrySource(loaded);

      expect([...rendered.keys()]).toEqual([
        "venues/alpha/venue.json",
        "venues/alpha/revisions/current/revision.json",
        "venues/alpha/revisions/2010/revision.json",
        "venues/alpha/revisions/historical/revision.json",
        "venues/alpha/revisions/historical/2011/revision.json",
        "venues/alpha/revisions/2010/tracks/legacy/metadata.json",
        "venues/alpha/revisions/historical/2011/tracks/nested/metadata.json",
        "venues/alpha/revisions/current/tracks/main/metadata.json",
      ]);
      expect(loaded).toEqual(source);
      expect(sourceSnapshot(locations)).toEqual(Object.fromEntries(rendered));
      expect(sourceHash(loaded)).toBe(sourceHash(source));
      expect(sourceHash(structuredClone(source))).toBe(sourceHash(source));
      buildTrackRegistryArtifacts(loaded, locations);
      const projection = readTrackRegistryProjection(locations.databasePath);
      expect(projection.venueNodes.map((venue) => venue.path)).toEqual([
        "alpha",
        "alpha/2010",
        "alpha/historical",
        "alpha/historical/2011",
      ]);
      expect(projection.venueNodes[0]?.metadata ?? null).toEqual(source.configurations.venues[0]?.metadata ?? null);
      expect(projection.venueNodes.slice(1).every((venue) => venue.metadata === null)).toBe(true);
      expect(projection.layouts.map((layout) => layout.canonical_id)).toEqual([
        "alpha/2010/legacy",
        "alpha/historical/2011/nested",
        "alpha/main",
      ]);
      expect(readTrackRegistryProjection(locations.databasePath).corners[0]!.name).toBe("Juncão");
    });
  });

  test("rejects venue metadata on historical revision nodes", () => {
    const source = baseSource();
    source.configurations.venues[1]!.metadata = source.configurations.venues[0]!.metadata;
    expect(() => renderTrackRegistrySource(source)).toThrow(/metadata belongs on root venue alpha/);
  });

  test("canonicalizes file bytes and rejects legacy or noncanonical metadata shards", () => {
    withWorkspace((locations) => {
      const source = baseSource();
      writeSource(locations, source);
      const mainPath = shardPath(locations, "venues/alpha/revisions/current/tracks/main/metadata.json");
      const main = JSON.parse(readFileSync(mainPath, "utf8")) as { assignments: unknown[] };
      main.assignments.reverse();
      writeFileSync(mainPath, JSON.stringify(main), "utf8");
      expect(() => assertTrackRegistryArtifactsCurrent(locations)).toThrow(/Non-canonical track registry source/);
      updateTrackRegistrySource(() => undefined, locations);
      expect(sourceSnapshot(locations)).toEqual(Object.fromEntries(renderTrackRegistrySource(source)));

      mkdirSync(locations.sourceDirectory, { recursive: true });
      writeFileSync(resolve(locations.sourceDirectory, "facts.json"), "{}", "utf8");
      expect(() => loadTrackRegistrySource(locations)).toThrow(/Unexpected aggregate track registry source/);
      rmSync(resolve(locations.sourceDirectory, "facts.json"));
      mkdirSync(shardPath(locations, "meta"), { recursive: true });
      writeFileSync(shardPath(locations, "meta/legacy.json"), "{}", "utf8");
      expect(() => loadTrackRegistrySource(locations)).toThrow(/Unexpected legacy track metadata directory/);
      rmSync(shardPath(locations, "meta"), { recursive: true });
      mkdirSync(shardPath(locations, "venues/alpha/revisions/current/tracks/unexpected"), { recursive: true });
      writeFileSync(shardPath(locations, "venues/alpha/revisions/current/tracks/unexpected/metadata.json"), JSON.stringify({
        version: TRACK_REGISTRY_SOURCE_VERSION,
        id: "alpha/main",
        name: "Unexpected",
        assignments: [],
      }), "utf8");
      expect(() => loadTrackRegistrySource(locations)).toThrow(/must match layout id/);
      rmSync(shardPath(locations, "venues/alpha/revisions/current/tracks/unexpected"), { recursive: true });
      mkdirSync(shardPath(locations, "venues/alpha/tracks/legacy"), { recursive: true });
      expect(() => loadTrackRegistrySource(locations)).toThrow(/Unexpected direct track metadata directory/);
      rmSync(shardPath(locations, "venues/alpha/tracks"), { recursive: true });
      mkdirSync(shardPath(locations, "venues/alpha/old/"), { recursive: true });
      writeFileSync(shardPath(locations, "venues/alpha/old/venue.json"), JSON.stringify({
        version: TRACK_REGISTRY_SOURCE_VERSION,
        id: "alpha/old",
        name: "Old",
      }), "utf8");
      expect(() => loadTrackRegistrySource(locations)).toThrow(/Unexpected nested venue metadata shard/);
      rmSync(shardPath(locations, "venues/alpha/old"), { recursive: true });
      const revisionPath = shardPath(locations, "venues/alpha/revisions/2010/revision.json");
      const revision = JSON.parse(readFileSync(revisionPath, "utf8")) as { id: string };
      revision.id = "alpha/2010";
      writeFileSync(revisionPath, JSON.stringify(revision), "utf8");
      expect(() => loadTrackRegistrySource(locations)).toThrow(/must match revision id/);
      writeFileSync(revisionPath, renderTrackRegistrySource(source).get("venues/alpha/revisions/2010/revision.json")!, "utf8");
      const currentRevisionPath = shardPath(locations, "venues/alpha/revisions/current/revision.json");
      const currentRevision = JSON.parse(readFileSync(currentRevisionPath, "utf8")) as { id: string };
      currentRevision.id = "alpha/current";
      writeFileSync(currentRevisionPath, JSON.stringify(currentRevision), "utf8");
      expect(() => loadTrackRegistrySource(locations)).toThrow(/must match revision id/);
      writeFileSync(currentRevisionPath, renderTrackRegistrySource(source).get("venues/alpha/revisions/current/revision.json")!, "utf8");
      mkdirSync(shardPath(locations, "iracing"), { recursive: true });
      writeFileSync(shardPath(locations, "iracing/oval-main-segments.json"), "{}", "utf8");
      expect(() => loadTrackRegistrySource(locations)).toThrow(/Unexpected legacy track segments shard/);
    });
  });

  test("updates added, changed, and removed layout shards with SQLite projection", () => {
    withWorkspace((locations) => {
      const source = baseSource();
      writeSource(locations, source);
      buildTrackRegistryArtifacts(source, locations);

      updateTrackRegistrySource((draft) => {
        draft.facts.facts[0]!.name = "Updated Oval Main";
        draft.configurations.layouts.push({ id: "alpha/historical/2011/added", name: "Added", factsSlug: "added-layout" });
        draft.configurations.assignments.push({ gameId: "fm-2023", trackOrdinal: 4, layoutId: "alpha/historical/2011/added", confirmation: null });
        draft.facts.facts.push({ slug: "added-layout", track: "alpha", layout: "oval", layoutName: "Oval", name: "Added Layout", corners: [{ number: 1, name: "One" }] });
        draft.geometry.geometry.push({ factsSlug: "added-layout", gameId: "fm-2023", segments: [{ key: "t1", startFrac: 0, endFrac: 1 }] });
      }, locations);
      expect(existsSync(shardPath(locations, "venues/alpha/revisions/historical/2011/tracks/added/metadata.json"))).toBe(true);
      expect(readTrackRegistryProjection(locations.databasePath).facts.map((fact) => fact.slug)).toEqual(["added-layout", "oval-main"]);

      updateTrackRegistrySource((draft) => {
        draft.configurations.layouts = draft.configurations.layouts.filter((layout) => layout.id !== "alpha/historical/2011/added");
        draft.configurations.assignments = draft.configurations.assignments.filter((assignment) => assignment.layoutId !== "alpha/historical/2011/added");
        draft.facts.facts = draft.facts.facts.filter((fact) => fact.slug !== "added-layout");
        draft.geometry.geometry = draft.geometry.geometry.filter((geometry) => geometry.factsSlug !== "added-layout");
      }, locations);
      expect(existsSync(shardPath(locations, "venues/alpha/revisions/historical/2011/tracks/added/metadata.json"))).toBe(false);
      const projection = readTrackRegistryProjection(locations.databasePath);
      expect(projection.facts).toHaveLength(1);
      expect(projection.facts[0]!.name).toBe("Updated Oval Main");
      expect(() => assertTrackRegistryArtifactsCurrent(locations)).not.toThrow();
    });
  });

  test("rejects layout removal while colocated assets remain", () => {

    withWorkspace((locations) => {
      const source = baseSource();
      writeSource(locations, source);
      buildTrackRegistryArtifacts(source, locations);
      const mapPath = shardPath(locations, "venues/alpha/revisions/2010/tracks/legacy/geometry/iracing/official/active.svg");
      mkdirSync(dirname(mapPath), { recursive: true });
      writeFileSync(mapPath, "{}\n", "utf8");
      const before = artifactSnapshot(locations);

      expect(() => updateTrackRegistrySource((draft) => {
        draft.configurations.layouts = draft.configurations.layouts
          .filter((layout) => layout.id !== "alpha/2010/legacy");
      }, locations)).toThrow(/colocated asset remains/);

      expect(artifactSnapshot(locations)).toEqual(before);
      expect(existsSync(mapPath)).toBe(true);
    });
  });
  test("rejects revision removal while revision assets remain", () => {
    withWorkspace((locations) => {
      const source = baseSource();
      writeSource(locations, source);
      buildTrackRegistryArtifacts(source, locations);
      const imageryPath = shardPath(locations, "venues/alpha/revisions/2010/imagery/active.svg");
      mkdirSync(dirname(imageryPath), { recursive: true });
      writeFileSync(imageryPath, "{}\n", "utf8");

      expect(() => updateTrackRegistrySource((draft) => {
        draft.configurations.venues = draft.configurations.venues
          .filter((venue) => venue.id !== "alpha/2010");
        draft.configurations.layouts = draft.configurations.layouts
          .filter((layout) => layout.id !== "alpha/2010/legacy");
      }, locations)).toThrow(/colocated asset remains/);
      expect(existsSync(imageryPath)).toBe(true);
    });
  });

  test("invalid mutation keeps source and artifacts byte-stable", () => {
    withWorkspace((locations) => {
      const source = baseSource();
      writeSource(locations, source);
      buildTrackRegistryArtifacts(source, locations);
      const before = artifactSnapshot(locations);
      expect(() => updateTrackRegistrySource((draft) => {
        draft.configurations.assignments.push({ gameId: "iracing", trackOrdinal: 1, layoutId: "alpha/main", confirmation: null });
      }, locations)).toThrow(/Duplicate assignment iracing #1/);
      expect(artifactSnapshot(locations)).toEqual(before);
    });
  });

  test("recovers completed addition and interrupted removal using dynamic shard sets", () => {
    withWorkspace((locations) => {
      const oldSource = baseSource();
      writeSource(locations, oldSource);
      buildTrackRegistryArtifacts(oldSource, locations);
      const completed = structuredClone(oldSource);
      completed.configurations.layouts.push({ id: "alpha/2010/recovered", name: "Recovered", factsSlug: "recovered" });
      completed.facts.facts.push({ slug: "recovered", track: "alpha", layout: "oval", layoutName: "Oval", name: "Recovered", corners: [{ number: 1, name: "One" }] });
      writeRecoveryJournal(locations, oldSource, completed);
      writeSource(locations, completed);
      recoverTrackRegistrySourceUpdate(locations);
      expect(existsSync(shardPath(locations, "venues/alpha/revisions/2010/tracks/recovered/metadata.json"))).toBe(true);
      expect(existsSync(locations.transactionPath)).toBe(false);

      const removal = structuredClone(completed);
      removal.configurations.layouts = removal.configurations.layouts.filter((layout) => layout.id !== "alpha/2010/recovered");
      removal.facts.facts = removal.facts.facts.filter((fact) => fact.slug !== "recovered");
      writeRecoveryJournal(locations, completed, removal);
      writeFileSync(shardPath(locations, "venues/alpha/revisions/current/tracks/main/metadata.json"), "{\"invalid\":true}", "utf8");
      recoverTrackRegistrySourceUpdate(locations);
      expect(existsSync(shardPath(locations, "venues/alpha/revisions/2010/tracks/recovered/metadata.json"))).toBe(true);
      expect(loadTrackRegistrySource(locations).facts.facts.some((fact) => fact.slug === "recovered")).toBe(true);
      expect(existsSync(locations.transactionPath)).toBe(false);
    });
  });
});
