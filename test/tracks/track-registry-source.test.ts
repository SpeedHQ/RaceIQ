import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  assertTrackRegistryArtifactsCurrent,
  buildTrackRegistryArtifacts,
  loadTrackRegistrySource,
  readTrackRegistryProjection,
  recoverTrackRegistrySourceUpdate,
  renderTrackRegistrySource,
  TRACK_REGISTRY_SOURCE_VERSION,
  type TrackRegistryLocations,
  type TrackRegistrySource,
  updateTrackRegistrySource,
} from "../../shared/racing/tracks/registry-source";
import { closeTrackRegistry } from "../../shared/racing/tracks/registry";

const TRACK_SOURCE_FILES = ["configurations.json", "facts.json", "geometry.json", "verification.json"] as const;

type SourceFile = (typeof TRACK_SOURCE_FILES)[number];

type ArtifactSnapshot = {
  source: Record<SourceFile, string>;
  database: string;
  report: string;
};

function makeRegistryWorkspace(): { root: string; locations: TrackRegistryLocations } {
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
  const { root, locations } = makeRegistryWorkspace();
  closeTrackRegistry();
  try {
    return run(locations);
  } finally {
    closeTrackRegistry();
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

function writeSourceFiles(locations: TrackRegistryLocations, source: TrackRegistrySource): void {
  const rendered = renderTrackRegistrySource(source);
  mkdirSync(locations.sourceDirectory, { recursive: true });
  for (const filename of TRACK_SOURCE_FILES) {
    writeFileSync(resolve(locations.sourceDirectory, filename), rendered.get(filename)!, "utf8");
  }
}

function writeUncheckedSourceFiles(locations: TrackRegistryLocations, source: TrackRegistrySource): void {
  mkdirSync(locations.sourceDirectory, { recursive: true });
  const documents: Record<SourceFile, unknown> = {
    "configurations.json": source.configurations,
    "facts.json": source.facts,
    "geometry.json": source.geometry,
    "verification.json": source.verification,
  };
  for (const filename of TRACK_SOURCE_FILES) {
    writeFileSync(resolve(locations.sourceDirectory, filename), `${JSON.stringify(documents[filename], null, 2)}\n`, "utf8");
  }
}

function writeSourcePayload(locations: TrackRegistryLocations, file: SourceFile, payload: unknown, pretty = false): void {
  mkdirSync(locations.sourceDirectory, { recursive: true });
  const body = JSON.stringify(payload, null, pretty ? 2 : 0);
  writeFileSync(resolve(locations.sourceDirectory, file), body, "utf8");
}

function readSourceSnapshot(locations: TrackRegistryLocations): Record<SourceFile, string> {
  const snapshot = {} as Record<SourceFile, string>;
  for (const filename of TRACK_SOURCE_FILES) {
    snapshot[filename] = readFileSync(resolve(locations.sourceDirectory, filename), "utf8");
  }
  return snapshot;
}

function snapshotArtifacts(locations: TrackRegistryLocations): ArtifactSnapshot {
  return {
    source: readSourceSnapshot(locations),
    database: readFileSync(locations.databasePath).toString("base64"),
    report: readFileSync(locations.reportPath, "utf8"),
  };
}

function sourceHash(source: TrackRegistrySource): string {
  const rendered = renderTrackRegistrySource(source);
  const hash = createHash("sha256");
  for (const filename of TRACK_SOURCE_FILES) {
    const body = rendered.get(filename);
    if (body === undefined) throw new Error(`Missing rendered source file ${filename}`);
    hash.update(filename).update("\0").update(body);
  }
  return hash.digest("hex");
}

function baseSource(): TrackRegistrySource {
  return {
    configurations: {
      version: TRACK_REGISTRY_SOURCE_VERSION,
      venues: [
        { id: "alpha", name: "Alpha" },
        { id: "alpha/oval", name: "Alpha Oval" },
      ],
      layouts: [
        { id: "alpha/oval/main", name: "Main", factsSlug: "oval-main" },
        { id: "alpha/oval/legacy", name: "Legacy" },
      ],
      assignments: [
        { gameId: "iracing", trackOrdinal: 1, layoutId: "alpha/oval/main", confirmation: null },
        { gameId: "fm-2023", trackOrdinal: 0, layoutId: "alpha/oval/main", confirmation: null },
      ],
    },
    facts: {
      version: TRACK_REGISTRY_SOURCE_VERSION,
      facts: [
        {
          slug: "oval-main",
          track: "alpha",
          layout: "oval",
          layoutName: "Oval",
          name: "Alpha Oval Main",
          corners: [
            { number: 1, name: "Turn 1", covers: [3, 2], direction: "left" },
            { number: 4, name: "Turn 4", direction: "right" },
          ],
          straights: [
            { after: 1, name: "Start Line", group: "pit" },
            { after: 4, name: "Finishing Straight" },
          ],
        },
      ],
    },
    geometry: {
      version: TRACK_REGISTRY_SOURCE_VERSION,
      geometry: [
        {
          factsSlug: "oval-main",
          gameId: "iracing",
          sectors: { s1End: 0.35, s2End: 0.75, source: "editor" },
          segments: [
            { key: "t1", startFrac: 0, endFrac: 0.5 },
            { key: "s1", startFrac: 0.5, endFrac: 1 },
          ],
        },
      ],
    },
    verification: {
      version: TRACK_REGISTRY_SOURCE_VERSION,
      entries: {
        "meta:oval-main": { hash: "meta-v1", date: "2026-01-01", by: "test", note: "source test" },
        "segments:iracing/oval-main": { hash: "seg-v1", date: "2026-01-02", note: "segment test" },
      },
    },
  };
}

function nestedVenueSource(): TrackRegistrySource {
  const source = baseSource();
  source.configurations.venues = [
    { id: "alpha", name: "Alpha" },
    { id: "alpha/club", name: "Club" },
    { id: "alpha/club/inner", name: "Inner" },
  ];
  source.configurations.layouts = [
    { id: "alpha/club/inner/main", name: "Inner Main", factsSlug: "oval-main" },
  ];
  source.configurations.assignments = [
    { gameId: "iracing", trackOrdinal: 0, layoutId: "alpha/club/inner/main", confirmation: null },
  ];
  return source;
}

describe("track registry source deterministic explicit-location behavior", () => {
  test("canonicalization rewrites non-canonical source formatting and sorting", () => {
    withWorkspace((locations) => {
      const unsorted = baseSource();
      const unsortedConfigurations = {
        version: TRACK_REGISTRY_SOURCE_VERSION,
        venues: unsorted.configurations.venues.slice().reverse(),
        layouts: unsorted.configurations.layouts.slice().reverse(),
        assignments: unsorted.configurations.assignments.slice().reverse(),
      };
      const unsortedPayload = {
        configurations: unsortedConfigurations,
        facts: unsorted.facts,
        geometry: unsorted.geometry,
        verification: unsorted.verification,
      };

      writeSourcePayload(locations, "configurations.json", unsortedPayload.configurations);
      writeSourcePayload(locations, "facts.json", unsortedPayload.facts);
      writeSourcePayload(locations, "geometry.json", unsortedPayload.geometry);
      writeSourcePayload(locations, "verification.json", unsortedPayload.verification);

      expect(() => assertTrackRegistryArtifactsCurrent(locations)).toThrow(
        /Non-canonical track registry source .*run bun run tracks:registry/,
      );

      updateTrackRegistrySource(() => undefined, locations);

      expect(() => assertTrackRegistryArtifactsCurrent(locations)).not.toThrow();
      const canonical = loadTrackRegistrySource(locations);
      const rendered = renderTrackRegistrySource(canonical);
      const files = readSourceSnapshot(locations);
      for (const filename of TRACK_SOURCE_FILES) {
        expect(files[filename], `${filename} canonical form`).toBe(rendered.get(filename)!);
      }

      expect(canonical.configurations.venues.map((venue) => venue.id)).toEqual(["alpha", "alpha/oval"]);
      expect(canonical.configurations.assignments.map((assignment) => assignment.gameId)).toEqual(["fm-2023", "iracing"]);
    });
  });

  test("validation rejects duplicate and orphaned identities", () => {
    withWorkspace((locations) => {
      const duplicateVenue = baseSource();
      duplicateVenue.configurations.venues.push({ id: "alpha", name: "Alpha Duplicate" });
      writeUncheckedSourceFiles(locations, duplicateVenue);
      expect(() => loadTrackRegistrySource(locations)).toThrow(/Duplicate venue alpha/);

      const missingVenueParent = baseSource();
      missingVenueParent.configurations.venues = [{ id: "alpha", name: "Alpha" }];
      missingVenueParent.configurations.layouts.push({ id: "alpha/club/main", name: "Missing Parent", factsSlug: "oval-main" });
      missingVenueParent.configurations.assignments = [];
      writeUncheckedSourceFiles(locations, missingVenueParent);
      expect(() => loadTrackRegistrySource(locations)).toThrow(/Missing layout venue for alpha\/club\/main/);
    });

    withWorkspace((locations) => {
      const invalidGeometry = baseSource();
      invalidGeometry.geometry.geometry.push({
        factsSlug: "oval-main",
        gameId: "fm-2023",
        segments: [{ key: "broken", startFrac: 0, endFrac: 1 }],
      });
      writeUncheckedSourceFiles(locations, invalidGeometry);
      expect(() => loadTrackRegistrySource(locations)).toThrow(/Invalid track geometry segment key|Malformed segment key broken/);
    });
  });

  test("orphaned references survive validation and are captured in report", () => {
    withWorkspace((locations) => {
      const source = baseSource();
      source.configurations.layouts.push({ id: "alpha/oval/unlinked", name: "Unlinked Layout" });
      source.facts.facts.push({
        slug: "orphan-fact",
        track: "alpha",
        layout: "oval",
        layoutName: "Oval",
        name: "Orphan Fact",
        corners: [{ number: 1, name: "Single" }],
      });

      writeSourceFiles(locations, source);
      buildTrackRegistryArtifacts(source, locations);

      const projection = readTrackRegistryProjection(locations.databasePath);
      const report = JSON.parse(readFileSync(locations.reportPath, "utf8")) as { unlinked: { layoutsWithoutFacts: string[]; factsWithoutLayouts: string[] } };

      expect(projection.facts.map((fact) => fact.slug).sort()).toEqual(["orphan-fact", "oval-main"]);
      expect(report.unlinked.layoutsWithoutFacts).toEqual(["alpha/oval/legacy", "alpha/oval/unlinked"]);
      expect(report.unlinked.factsWithoutLayouts).toEqual(["orphan-fact"]);
    });
  });

  test("same source build is deterministic and readback lossless", () => {
    withWorkspace((locations) => {
      const source = baseSource();
      writeSourceFiles(locations, source);

      const first = buildTrackRegistryArtifacts(source, locations);
      const second = buildTrackRegistryArtifacts(source, locations);

      expect(second.sourceHash).toBe(first.sourceHash);
      expect(JSON.stringify(second.projection)).toBe(JSON.stringify(first.projection));
      expect(second.report).toBe(first.report);

      const live = readTrackRegistryProjection(locations.databasePath);
      expect(live).toEqual(first.projection);
      expect(readFileSync(locations.reportPath, "utf8")).toBe(first.report);
    });
  });

  test("assertTrackRegistryArtifactsCurrent surfaces stale or missing artifacts", () => {
    withWorkspace((locations) => {
      const source = baseSource();
      writeSourceFiles(locations, source);
      buildTrackRegistryArtifacts(source, locations);
      source.facts.facts[0]!.name = "Stale Source";
      writeSourceFiles(locations, source);
      expect(() => assertTrackRegistryArtifactsCurrent(locations)).toThrow(/Stale generated track registry; run bun run tracks:registry/);
    });

    withWorkspace((locations) => {
      const source = baseSource();
      writeSourceFiles(locations, source);
      buildTrackRegistryArtifacts(source, locations);

      writeFileSync(locations.reportPath, `${readFileSync(locations.reportPath, "utf8")}\n`, "utf8");
      expect(() => assertTrackRegistryArtifactsCurrent(locations)).toThrow(/Stale track registry report; run bun run tracks:registry/);
    });

    withWorkspace((locations) => {
      const source = baseSource();
      writeSourceFiles(locations, source);
      buildTrackRegistryArtifacts(source, locations);
      writeFileSync(locations.transactionPath, "{}", "utf8");
      expect(() => assertTrackRegistryArtifactsCurrent(locations)).toThrow(/Pending track registry source update/);
    });
  });

  test("successful mutation updates source JSON, SQLite projection, and report", () => {
    withWorkspace((locations) => {
      const source = baseSource();
      writeSourceFiles(locations, source);
      buildTrackRegistryArtifacts(source, locations);

      updateTrackRegistrySource((draft) => {
        draft.facts.facts[0]!.name = "Updated Oval Main";
        draft.geometry.geometry[0]!.sectors = {
          s1End: 0.42,
          s2End: 0.81,
          source: "updated" ,
        };
      }, locations);

      const projection = readTrackRegistryProjection(locations.databasePath);
      const report = JSON.parse(readFileSync(locations.reportPath, "utf8")) as { geometrySectors: Array<{ gameId: string; factsSlug: string; s1End: number; s2End: number }> };

      const current = loadTrackRegistrySource(locations);
      expect(current.facts.facts[0]!.name).toBe("Updated Oval Main");
      expect(current.geometry.geometry[0]!.sectors).toEqual({ s1End: 0.42, s2End: 0.81, source: "updated" });
      expect(projection.facts[0]!.name).toBe("Updated Oval Main");
      expect(projection.geometry[0]!).toMatchObject({ sector_1_end: 0.42, sector_2_end: 0.81 });
      expect(report.geometrySectors[0]).toMatchObject({ factsSlug: "oval-main", s1End: 0.42, s2End: 0.81 });
    });
  });

  test("invalid mutation rolls back and leaves artifacts byte-stable", () => {
    withWorkspace((locations) => {
      const source = baseSource();
      writeSourceFiles(locations, source);
      buildTrackRegistryArtifacts(source, locations);

      const before = snapshotArtifacts(locations);
      expect(() => {
        updateTrackRegistrySource((draft) => {
          draft.configurations.assignments.push({
            gameId: "iracing",
            trackOrdinal: source.configurations.assignments[0]!.trackOrdinal,
            layoutId: source.configurations.assignments[0]!.layoutId,
            confirmation: null,
          });
        }, locations);
      }).toThrow(/Duplicate assignment iracing #1/);

      const after = snapshotArtifacts(locations);
      expect(after).toEqual(before);
      expect(existsSync(locations.transactionPath)).toBe(false);
    });
  });

  test("self-referential venue refresh succeeds through runtime projection writer", () => {
    withWorkspace((locations) => {
      const source = nestedVenueSource();
      writeSourceFiles(locations, source);
      buildTrackRegistryArtifacts(source, locations);

      const script = `
        import { updateTrackRegistrySource } from "./shared/racing/tracks/registry-source";
        updateTrackRegistrySource((draft) => {
          draft.configurations.venues.push({ id: "alpha/club/inner/garage", name: "Garage" });
          draft.configurations.layouts.push({
            id: "alpha/club/inner/garage/main",
            name: "Garage Main",
            factsSlug: "oval-main",
          });
        });
      `;
      const result = Bun.spawnSync(["bun", "-e", script], {
        cwd: resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          NODE_ENV: "test",
          RACEIQ_TEST_MODE: "1",
          RACEIQ_TRACK_REGISTRY_DIR: resolve(locations.sourceDirectory, ".."),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = new TextDecoder().decode(result.stderr);
      expect(result.exitCode, stderr).toBe(0);

      const projection = readTrackRegistryProjection(locations.databasePath);
      expect(projection.venueNodes.some((row) => row.path === "alpha/club/inner/garage")).toBe(true);
    });
  });

  test("recovering pending journal completes new transaction when source already matches new hash", () => {
    withWorkspace((locations) => {
      const oldSource = baseSource();
      const newSource = baseSource();
      newSource.facts.facts[0]!.name = "Committed Variant";
      newSource.geometry.geometry[0]!.sectors = { s1End: 0.44, s2End: 0.82, source: "variant" };

      const oldRendered = renderTrackRegistrySource(oldSource);
      const newRendered = renderTrackRegistrySource(newSource);

      mkdirSync(locations.sourceDirectory, { recursive: true });
      for (const filename of TRACK_SOURCE_FILES) {
        writeFileSync(resolve(locations.sourceDirectory, filename), oldRendered.get(filename)!, "utf8");
      }
      buildTrackRegistryArtifacts(oldSource, locations);

      const sourceBackups: Record<string, string> = {};
      const sourceStaged: Record<string, string> = {};
      for (const filename of TRACK_SOURCE_FILES) {
        const sourcePath = resolve(locations.sourceDirectory, filename);
        const backup = resolve(locations.sourceDirectory, `.${filename}.backup.complete`);
        const staged = resolve(locations.sourceDirectory, `.${filename}.stage.complete`);
        cpSync(sourcePath, backup);
        writeFileSync(staged, newRendered.get(filename)!, "utf8");
        sourceBackups[filename] = backup;
        sourceStaged[filename] = staged;
      }

      for (const filename of TRACK_SOURCE_FILES) {
        writeFileSync(resolve(locations.sourceDirectory, filename), newRendered.get(filename)!, "utf8");
      }

      const journal = {
        version: 1,
        oldSourceHash: sourceHash(oldSource),
        newSourceHash: sourceHash(newSource),
        sourceBackups,
        sourceStaged,
        databaseBackup: `${locations.databasePath}.backup`,
        databaseStaged: `${locations.databasePath}.stage`,
        reportBackup: `${locations.reportPath}.backup`,
        reportStaged: `${locations.reportPath}.stage`,
      };
      writeFileSync(locations.transactionPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");

      recoverTrackRegistrySourceUpdate(locations);

      const restored = loadTrackRegistrySource(locations);
      expect(restored.facts.facts[0]!.name).toBe("Committed Variant");
      const projection = readTrackRegistryProjection(locations.databasePath);
      expect(projection.facts[0]!.name).toBe("Committed Variant");
      expect(projection.geometry[0]!).toMatchObject({ sector_1_end: 0.44, sector_2_end: 0.82 });
      expect(existsSync(locations.transactionPath)).toBe(false);
      expect(sourceHash(restored)).toBe(sourceHash(newSource));
    });
  });

  test("recovering pending journal restores old state when source is not at new hash", () => {
    withWorkspace((locations) => {
      const oldSource = baseSource();
      const newSource = baseSource();
      newSource.facts.facts[0]!.name = "Rollback Variant";

      mkdirSync(locations.sourceDirectory, { recursive: true });
      const oldRendered = renderTrackRegistrySource(oldSource);
      const newRendered = renderTrackRegistrySource(newSource);

      for (const filename of TRACK_SOURCE_FILES) {
        writeFileSync(resolve(locations.sourceDirectory, filename), oldRendered.get(filename)!, "utf8");
      }
      buildTrackRegistryArtifacts(oldSource, locations);

      const sourceBackups: Record<string, string> = {};
      for (const filename of TRACK_SOURCE_FILES) {
        const sourcePath = resolve(locations.sourceDirectory, filename);
        const backup = resolve(locations.sourceDirectory, `.${filename}.backup.rollback`);
        cpSync(sourcePath, backup);
        sourceBackups[filename] = backup;
      }

      for (const filename of TRACK_SOURCE_FILES) {
        writeFileSync(resolve(locations.sourceDirectory, filename), "{\"invalid\":true}", "utf8");
      }

      const journal = {
        version: 1,
        oldSourceHash: sourceHash(oldSource),
        newSourceHash: sourceHash(newSource),
        sourceBackups,
        sourceStaged: Object.fromEntries(TRACK_SOURCE_FILES.map((file) => [file, resolve(locations.sourceDirectory, `.${file}.stage.rollback`)])) as Record<
          string,
          string
        >,
        databaseBackup: `${locations.databasePath}.backup`,
        databaseStaged: `${locations.databasePath}.stage`,
        reportBackup: `${locations.reportPath}.backup`,
        reportStaged: `${locations.reportPath}.stage`,
      };

      writeFileSync(locations.transactionPath, `${JSON.stringify(journal, null, 2)}\n`, "utf8");

      recoverTrackRegistrySourceUpdate(locations);

      const restored = loadTrackRegistrySource(locations);
      expect(restored.facts.facts[0]!.name).toBe("Alpha Oval Main");
      const projection = readTrackRegistryProjection(locations.databasePath);
      expect(projection.facts[0]!.name).toBe("Alpha Oval Main");
      expect(projection.geometry[0]!).toMatchObject({ sector_1_end: 0.35, sector_2_end: 0.75 });
      expect(newRendered.get("facts.json")).not.toEqual(readFileSync(resolve(locations.sourceDirectory, "facts.json"), "utf8"));
    });
  });
});
