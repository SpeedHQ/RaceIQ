import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { initGameAdapters } from "../../shared/games/init";
import {
  loadTrackGeometryForGame,
  saveTrackMetadata,
} from "../../shared/racing/tracks/storage/meta";
import {
  loadTrackRegistrySource,
  resolveTrackRegistryLocations,
  updateTrackRegistrySource,
} from "../../shared/racing/tracks/registry-source";
import { trackSectorBoundaryRoutes, trackSegmentRoutes } from "../../server/routes/tracks/segments-routes";
import { trackGeometryRoutes } from "../../server/routes/tracks/geometry-routes";

initGameAdapters({ f1Experiments: false, iracingAdapter: true });

const TRACK_REGISTRY_SOURCE_FILES = [
  "configurations.json",
  "facts.json",
  "geometry.json",
  "verification.json",
] as const;

const TRACK_REGISTRY_LOCATIONS = resolveTrackRegistryLocations();
const REPO_TRACK_REGISTRY_DIR = resolve(import.meta.dir, "../..", "shared", "data", "tracks");
const REPO_TRACK_REGISTRY_SOURCE_DIR = resolve(REPO_TRACK_REGISTRY_DIR, "registry-source");

const TRACK_SECTOR_FIXTURE = (() => {
  const source = loadTrackRegistrySource();
  for (const assignment of source.configurations.assignments) {
    if (assignment.gameId !== "fm-2023") continue;
    const layout = source.configurations.layouts.find((layout) => layout.id === assignment.layoutId);
    const factsSlug = layout?.factsSlug;
    if (!factsSlug) continue;
    const geometry = source.geometry.geometry.find((entry) =>
      entry.factsSlug === factsSlug && entry.gameId === assignment.gameId
    );
    const facts = source.facts.facts.find((entry) => entry.slug === factsSlug);
    if (!facts || !geometry?.sectors || geometry.sectors.s2End <= 0.43 || geometry.segments.length < 2) continue;
    return {
      trackOrdinal: assignment.trackOrdinal,
      gameId: assignment.gameId,
      factsSlug,
      s2End: geometry.sectors.s2End,
      segmentCount: geometry.segments.length,
      originalFacts: facts,
      originalGeometry: {
        sectors: geometry.sectors,
        segments: geometry.segments,
      },
    };
  }
  throw new Error("No writable fm-2023 non-native geometry fixture in test registry");
})();

function readTrackRegistrySourceFiles(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const filename of TRACK_REGISTRY_SOURCE_FILES) {
    out[filename] = readFileSync(resolve(root, filename), "utf-8");
  }
  return out;
}

function expectSourceFilesUnchanged(before: Record<string, string>, after: Record<string, string>): void {
  for (const filename of TRACK_REGISTRY_SOURCE_FILES) {
    expect(after[filename]).toBe(before[filename]);
  }
}
function readRepoGeneratedArtifacts(): { database: Buffer; report: Buffer } {
  return {
    database: readFileSync(resolve(REPO_TRACK_REGISTRY_DIR, "registry.sqlite")),
    report: readFileSync(resolve(REPO_TRACK_REGISTRY_DIR, "registry-report.json")),
  };
}


async function setTrackSectors(s1End: number, s2End: number): Promise<void> {
  const response = await trackSectorBoundaryRoutes.request(
    `/api/track-sector-boundaries/${TRACK_SECTOR_FIXTURE.trackOrdinal}?gameId=${TRACK_SECTOR_FIXTURE.gameId}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ s1End, s2End }),
    },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ success: true, s1End, s2End });
}

describe("optional track geometry routes", () => {
  test("returns null instead of an error when curb data is unavailable", async () => {
    const response = await trackGeometryRoutes.request(
      "/api/track-curbs/999999?gameId=iracing",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });
});

describe("track sector boundary routes", () => {
  test("requires validated gameId on GET", async () => {
    const response = await trackSectorBoundaryRoutes.request(
      "/api/track-sector-boundaries/1",
    );

    expect(response.status).toBe(400);
  });
  
  test("rejects invalid gameId on GET", async () => {
    const response = await trackSectorBoundaryRoutes.request(
      "/api/track-sector-boundaries/1?gameId=unknown",
    );

    expect(response.status).toBe(400);
  });

  test("reports native ownership without RaceIQ fallback", async () => {
    const response = await trackSectorBoundaryRoutes.request(
      "/api/track-sector-boundaries/1?gameId=iracing",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ownership: "game",
      editable: false,
      sectorStarts: null,
    });
  });

  test("reports editable RaceIQ timing boundaries for non-native games", async () => {
    const response = await trackSectorBoundaryRoutes.request(
      "/api/track-sector-boundaries/1?gameId=fm-2023",
    );

    expect(response.status).toBe(200);
    const body = await response.json() as {
      ownership: string;
      editable: boolean;
      sectorStarts: number[];
      s1End: number;
      s2End: number;
      trackLength: number;
    };
    expect(body.ownership).toBe("raceiq");
    expect(body.editable).toBe(true);
    expect(body.sectorStarts).toEqual([0, body.s1End, body.s2End]);
    expect(body.trackLength).toBeGreaterThanOrEqual(0);
  });

  test("persists sector and segment edits through isolated source and SQLite projection", async () => {
    const repoBefore = readTrackRegistrySourceFiles(REPO_TRACK_REGISTRY_SOURCE_DIR);
    const repoGeneratedBefore = readRepoGeneratedArtifacts();
    try {
    await setTrackSectors(0.41, TRACK_SECTOR_FIXTURE.s2End);

    const testRootBefore = readTrackRegistrySourceFiles(TRACK_REGISTRY_LOCATIONS.sourceDirectory);
    const geometryBefore = loadTrackRegistrySource().geometry.geometry.find((entry) =>
      entry.factsSlug === TRACK_SECTOR_FIXTURE.factsSlug && entry.gameId === TRACK_SECTOR_FIXTURE.gameId
    );
    const projectionBefore = loadTrackGeometryForGame(TRACK_SECTOR_FIXTURE.factsSlug, TRACK_SECTOR_FIXTURE.gameId);
    expect(geometryBefore?.sectors?.s1End).toBe(0.41);
    expect(projectionBefore?.sectors?.s1End).toBe(0.41);
    expect(geometryBefore?.segments).toHaveLength(TRACK_SECTOR_FIXTURE.segmentCount);
    expect(projectionBefore?.segments).toEqual(geometryBefore?.segments);

    await setTrackSectors(0.43, TRACK_SECTOR_FIXTURE.s2End);

    const testRootAfterSector = readTrackRegistrySourceFiles(TRACK_REGISTRY_LOCATIONS.sourceDirectory);
    expectSourceFilesUnchanged(repoBefore, readTrackRegistrySourceFiles(REPO_TRACK_REGISTRY_SOURCE_DIR));
    expect(testRootAfterSector["configurations.json"]).toBe(testRootBefore["configurations.json"]);
    expect(testRootAfterSector["facts.json"]).toBe(testRootBefore["facts.json"]);
    expect(testRootAfterSector["verification.json"]).toBe(testRootBefore["verification.json"]);
    expect(testRootAfterSector["geometry.json"]).not.toBe(testRootBefore["geometry.json"]);

    const geometryAfterSector = loadTrackRegistrySource().geometry.geometry.find((entry) =>
      entry.factsSlug === TRACK_SECTOR_FIXTURE.factsSlug && entry.gameId === TRACK_SECTOR_FIXTURE.gameId
    );
    expect(geometryAfterSector?.sectors?.s1End).toBe(0.43);
    expect(geometryAfterSector?.sectors?.s2End).toBe(TRACK_SECTOR_FIXTURE.s2End);
    expect(geometryAfterSector?.segments).toEqual(geometryBefore?.segments);

    const projectionAfterSector = loadTrackGeometryForGame(TRACK_SECTOR_FIXTURE.factsSlug, TRACK_SECTOR_FIXTURE.gameId);
    expect(projectionAfterSector?.sectors?.s1End).toBe(0.43);
    expect(projectionAfterSector?.sectors?.s2End).toBe(TRACK_SECTOR_FIXTURE.s2End);
    expect(projectionAfterSector?.segments).toEqual(projectionBefore?.segments);

    const sectorResponse = await trackSectorBoundaryRoutes.request(
      `/api/track-sector-boundaries/${TRACK_SECTOR_FIXTURE.trackOrdinal}?gameId=${TRACK_SECTOR_FIXTURE.gameId}`,
    );
    expect(sectorResponse.status).toBe(200);
    expect(await sectorResponse.json()).toMatchObject({
      ownership: "raceiq",
      editable: true,
      sectorStarts: [0, 0.43, TRACK_SECTOR_FIXTURE.s2End],
    });

    const segmentResponseBefore = await trackSegmentRoutes.request(
      `/api/track-sectors/${TRACK_SECTOR_FIXTURE.trackOrdinal}?gameId=${TRACK_SECTOR_FIXTURE.gameId}`,
    );
    expect(segmentResponseBefore.status).toBe(200);
    const segmentBodyBefore = await segmentResponseBefore.json() as {
      segments: Array<{
        type: string;
        name: string;
        number?: number;
        covers?: number[];
        direction?: "left" | "right";
        group?: string;
        startFrac: number;
        endFrac: number;
      }>;
    };
    expect(segmentBodyBefore.segments).toHaveLength(TRACK_SECTOR_FIXTURE.segmentCount);
    const editedSegments = segmentBodyBefore.segments.map((segment) => ({ ...segment }));
    const initialBoundary = editedSegments[0].endFrac;
    const editedBoundary = (initialBoundary + editedSegments[1].endFrac) / 2;
    editedSegments[0].endFrac = editedBoundary;
    editedSegments[1].startFrac = editedBoundary;

    const segmentPutResponse = await trackSegmentRoutes.request(
      `/api/tracks/${TRACK_SECTOR_FIXTURE.trackOrdinal}/segments?gameId=${TRACK_SECTOR_FIXTURE.gameId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ segments: editedSegments }),
      },
    );
    expect(segmentPutResponse.status).toBe(200);
    expect(await segmentPutResponse.json()).toEqual({
      success: true,
      count: editedSegments.length,
    });

    const testRootAfterSegments = readTrackRegistrySourceFiles(TRACK_REGISTRY_LOCATIONS.sourceDirectory);
    expect(testRootAfterSegments["configurations.json"]).toBe(testRootAfterSector["configurations.json"]);
    expect(testRootAfterSegments["facts.json"]).toBe(testRootAfterSector["facts.json"]);
    expect(testRootAfterSegments["verification.json"]).toBe(testRootAfterSector["verification.json"]);
    expect(testRootAfterSegments["geometry.json"]).not.toBe(testRootAfterSector["geometry.json"]);

    const geometryAfterSegments = loadTrackRegistrySource().geometry.geometry.find((entry) =>
      entry.factsSlug === TRACK_SECTOR_FIXTURE.factsSlug && entry.gameId === TRACK_SECTOR_FIXTURE.gameId
    );
    expect(geometryAfterSegments?.sectors?.s1End).toBe(0.43);
    expect(geometryAfterSegments?.segments).toHaveLength(TRACK_SECTOR_FIXTURE.segmentCount);
    expect(geometryAfterSegments?.segments[0].endFrac).toBe(editedBoundary);
    expect(geometryAfterSegments?.segments[1].startFrac).toBe(editedBoundary);

    const projectionAfterSegments = loadTrackGeometryForGame(TRACK_SECTOR_FIXTURE.factsSlug, TRACK_SECTOR_FIXTURE.gameId);
    expect(projectionAfterSegments?.sectors?.s1End).toBe(0.43);
    expect(projectionAfterSegments?.segments).toEqual(geometryAfterSegments?.segments);

    const segmentResponseAfter = await trackSegmentRoutes.request(
      `/api/track-sectors/${TRACK_SECTOR_FIXTURE.trackOrdinal}?gameId=${TRACK_SECTOR_FIXTURE.gameId}`,
    );
    expect(segmentResponseAfter.status).toBe(200);
    const segmentBodyAfter = await segmentResponseAfter.json() as {
      segments: Array<{ startFrac: number; endFrac: number }>;
    };
    expect(segmentBodyAfter.segments[0].endFrac).toBe(editedBoundary);
    expect(segmentBodyAfter.segments[1].startFrac).toBe(editedBoundary);
      expectSourceFilesUnchanged(repoBefore, readTrackRegistrySourceFiles(REPO_TRACK_REGISTRY_SOURCE_DIR));
      expect(readRepoGeneratedArtifacts()).toEqual(repoGeneratedBefore);
    } finally {
      saveTrackMetadata(
        TRACK_SECTOR_FIXTURE.factsSlug,
        TRACK_SECTOR_FIXTURE.originalFacts,
        { [TRACK_SECTOR_FIXTURE.gameId]: TRACK_SECTOR_FIXTURE.originalGeometry },
      );
    }
  });

  test("rejects native PUT before parsing malformed body", async () => {
    const repoBefore = readTrackRegistrySourceFiles(REPO_TRACK_REGISTRY_SOURCE_DIR);
    const testRootBefore = readTrackRegistrySourceFiles(TRACK_REGISTRY_LOCATIONS.sourceDirectory);
    const response = await trackSectorBoundaryRoutes.request(
      "/api/track-sector-boundaries/1?gameId=iracing",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: "{ malformed",
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "native-sectors-read-only",
      message: "Native sector boundaries are supplied by the game and cannot be edited",
    });
    expectSourceFilesUnchanged(repoBefore, readTrackRegistrySourceFiles(REPO_TRACK_REGISTRY_SOURCE_DIR));
    expectSourceFilesUnchanged(testRootBefore, readTrackRegistrySourceFiles(TRACK_REGISTRY_LOCATIONS.sourceDirectory));
  });

  test("keeps ordered-fraction validation for non-native PUT", async () => {
    const repoBefore = readTrackRegistrySourceFiles(REPO_TRACK_REGISTRY_SOURCE_DIR);
    const testRootBefore = readTrackRegistrySourceFiles(TRACK_REGISTRY_LOCATIONS.sourceDirectory);
    const response = await trackSectorBoundaryRoutes.request(
      `/api/track-sector-boundaries/${TRACK_SECTOR_FIXTURE.trackOrdinal}?gameId=${TRACK_SECTOR_FIXTURE.gameId}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ s1End: 0.7, s2End: 0.3 }),
      },
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Invalid sector boundaries: need 0 < s1End < s2End < 1",
    });
    expectSourceFilesUnchanged(repoBefore, readTrackRegistrySourceFiles(REPO_TRACK_REGISTRY_SOURCE_DIR));
    expectSourceFilesUnchanged(testRootBefore, readTrackRegistrySourceFiles(TRACK_REGISTRY_LOCATIONS.sourceDirectory));
  });

  test("serves SQL only and persists explicit generated previews through canonical JSON", async () => {
    const gameId = "iracing";
    const trackOrdinal = 123;
    const repoBefore = readTrackRegistrySourceFiles(REPO_TRACK_REGISTRY_SOURCE_DIR);
    const isolatedBefore = loadTrackRegistrySource();
    const isolatedFilesBefore = readTrackRegistrySourceFiles(TRACK_REGISTRY_LOCATIONS.sourceDirectory);
    const isolatedDatabaseBefore = readFileSync(TRACK_REGISTRY_LOCATIONS.databasePath);
    const assignmentBefore = isolatedBefore.configurations.assignments.find(
      (entry) => entry.gameId === gameId && entry.trackOrdinal === trackOrdinal,
    );
    const layoutBefore = isolatedBefore.configurations.layouts.find((entry) => entry.id === assignmentBefore?.layoutId);
    expect(assignmentBefore).toBeDefined();
    expect(layoutBefore?.factsSlug).toBeUndefined();

    try {
      const missingResponse = await trackSegmentRoutes.request(
        `/api/track-sectors/${trackOrdinal}?gameId=${gameId}`,
      );
      expect(missingResponse.status).toBe(200);
      expect(await missingResponse.json()).toEqual({ segments: [] });

      const generateResponse = await trackSegmentRoutes.request(
        `/api/tracks/${trackOrdinal}/segments/generate?gameId=${gameId}`,
        { method: "POST" },
      );
      expect(generateResponse.status).toBe(200);
      const generated = await generateResponse.json() as {
        source: string;
        segments: Array<{ type: string; startFrac: number; endFrac: number }>;
      };
      expect(generated.source).toBe("auto");
      expect(generated.segments.length).toBeGreaterThan(0);
      expectSourceFilesUnchanged(isolatedFilesBefore, readTrackRegistrySourceFiles(TRACK_REGISTRY_LOCATIONS.sourceDirectory));
      expect(readFileSync(TRACK_REGISTRY_LOCATIONS.databasePath)).toEqual(isolatedDatabaseBefore);

      const saveResponse = await trackSegmentRoutes.request(
        `/api/tracks/${trackOrdinal}/segments?gameId=${gameId}`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ segments: generated.segments }),
        },
      );
      expect(saveResponse.status).toBe(200);

      const sourceAfter = loadTrackRegistrySource();
      const assignmentAfter = sourceAfter.configurations.assignments.find(
        (entry) => entry.gameId === gameId && entry.trackOrdinal === trackOrdinal,
      );
      const layoutAfter = sourceAfter.configurations.layouts.find((entry) => entry.id === assignmentAfter?.layoutId);
      expect(layoutAfter?.factsSlug).toBe(assignmentAfter?.layoutId.replaceAll("/", "-"));
      const geometryAfter = sourceAfter.geometry.geometry.find(
        (entry) => entry.factsSlug === layoutAfter?.factsSlug && entry.gameId === gameId,
      );
      expect(geometryAfter?.segments.length).toBe(generated.segments.length);
      expect(loadTrackGeometryForGame(layoutAfter!.factsSlug!, gameId)?.segments).toEqual(geometryAfter?.segments);

      const persistedResponse = await trackSegmentRoutes.request(
        `/api/track-sectors/${trackOrdinal}?gameId=${gameId}`,
      );
      expect(persistedResponse.status).toBe(200);
      const persisted = await persistedResponse.json() as {
        source: string;
        segments: Array<{ type: string; startFrac: number; endFrac: number }>;
      };
      expect(persisted.source).toBe("shared");
      expect(persisted.segments.map(({ type, startFrac, endFrac }) => ({ type, startFrac, endFrac }))).toEqual(
        generated.segments.map(({ type, startFrac, endFrac }) => ({ type, startFrac, endFrac })),
      );
      expectSourceFilesUnchanged(repoBefore, readTrackRegistrySourceFiles(REPO_TRACK_REGISTRY_SOURCE_DIR));
    } finally {
      updateTrackRegistrySource(() => isolatedBefore);
    }
  });
});
