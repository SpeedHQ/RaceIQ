import { expect, test } from "bun:test";
import { KNOWN_GAME_IDS } from "../shared/games/ids";
import { fmTrackCatalog } from "../shared/racing/tracks/catalogs/fm";
import { getF1Tracks } from "../shared/racing/tracks/catalogs/f1";
import { getAccTracks } from "../shared/racing/tracks/catalogs/acc";
import { getAcEvoTracks } from "../shared/racing/tracks/catalogs/ac-evo";
import { getAllIRacingTracks } from "../shared/racing/tracks/catalogs/iracing";
import { buildMarketingTrackWallFixture } from "../scripts/marketing/track-wall-data";
import { createProjects } from "../playwright/config/projects";
import type { E2ERuntime, ServerPorts } from "../playwright/config/runtime";

const fixture = buildMarketingTrackWallFixture();
const expectedCounts = [fmTrackCatalog.size, getF1Tracks().size, getAccTracks().size, getAcEvoTracks().size, getAllIRacingTracks().length];

const ports = (port: number): ServerPorts => ({
  port: String(port),
  clientPort: String(port + 1_000),
  udpPort: String(port + 10_000),
  dataDir: `/tmp/raceiq-playwright-${port}`,
});

const playwrightRuntime: E2ERuntime = {
  serverMode: "compiled",
  serverSet: "all",
  devServer: false,
  screenshotOnly: false,
  seededScreenshots: false,
  parallelScreenshotRun: false,
  screenshotWorkers: 1,
  testWorkers: 1,
  needsFreshServer: true,
  needsTunesServer: true,
  needsTunesUnseededServer: true,
  needsSeededServer: true,
  freshInstall: ports(3118),
  tunes: ports(3119),
  tunesUnseeded: ports(3122),
  seeded: ports(3120),
};

test("records the 3D demo at a native 1080p viewport", () => {
  const project = createProjects(playwrightRuntime).find((candidate) => candidate.name === "record-demo");
  expect(project?.use?.viewport).toEqual({ width: 1920, height: 1080 });
});

test("captures marketing pages from the seeded app by default", () => {
  const previousBaseUrl = process.env.MARKETING_BASE_URL;
  delete process.env.MARKETING_BASE_URL;
  try {
    const project = createProjects(playwrightRuntime).find((candidate) => candidate.name === "marketing");
    expect(project?.use?.baseURL).toBe("http://localhost:3120");
  } finally {
    if (previousBaseUrl === undefined) delete process.env.MARKETING_BASE_URL;
    else process.env.MARKETING_BASE_URL = previousBaseUrl;
  }
});

test("matches authoritative catalog membership and counts", () => {
  expect(fixture.games.map((game) => game.gameId)).toEqual([...KNOWN_GAME_IDS]);
  expect(fixture.games.map((game) => game.count)).toEqual(expectedCounts);
  expect(fixture.tracks).toHaveLength(expectedCounts.reduce((sum, count) => sum + count, 0));
  expect(new Set(fixture.tracks.map((track) => track.key)).size).toBe(fixture.tracks.length);
});

test("is byte-equivalent and uses the declared synthetic count formula", () => {
  expect(JSON.stringify(buildMarketingTrackWallFixture())).toBe(JSON.stringify(fixture));
  for (const track of fixture.tracks) {
    expect(track.lapCount).toBeGreaterThanOrEqual(3);
    expect(track.lapCount).toBeLessThanOrEqual(148);
    expect(track.setupCount).toBeGreaterThanOrEqual(0);
    expect(track.setupCount).toBeLessThanOrEqual(12);
    expect(track.mapKind === "none").toBe(track.mapSrc === null);
  }
});

test("weaves every normalized catalog row exactly once", () => {
  const keys = fixture.tracks.map((track) => track.key);
  expect(new Set(keys).size).toBe(keys.length);
  for (const gameId of KNOWN_GAME_IDS) {
    expect(keys.filter((key) => key.startsWith(`${gameId}:`))).toHaveLength(fixture.games.find((game) => game.gameId === gameId)?.count ?? 0);
  }
});
