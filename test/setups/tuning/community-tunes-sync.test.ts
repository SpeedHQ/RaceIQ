import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { db } from "../../../server/db/index";
import { communityTunes } from "../../../server/db/schema";
import {
  getCommunityTunes,
  getCommunityTuneById,
  replaceCommunityTunes,
} from "../../../server/db/community-tune-queries";
import { setCommunityTunesSyncState } from "../../../server/runtime/config/settings";
import { syncCommunityTunes } from "../../../server/tunes/community-sync"

// Follows DATA_DIR so this never mutates the real dev database/settings —
// `bun run test` isolates DATA_DIR to a throwaway directory (see package.json).
const SETTINGS_PATH = `${process.env.DATA_DIR ?? "./data"}/settings.json`;

const SETTINGS = {
  tires: { frontPressure: 30, rearPressure: 31 },
  gearing: { finalDrive: 3.4 },
  alignment: { frontCamber: -1, rearCamber: -0.8, frontToe: 0, rearToe: 0.1 },
  antiRollBars: { front: 22, rear: 18 },
  springs: { frontRate: 750, rearRate: 680, frontHeight: 5, rearHeight: 5 },
  damping: { frontRebound: 8, rearRebound: 7, frontBump: 5, rearBump: 4 },
  aero: { frontDownforce: 185, rearDownforce: 220 },
  differential: { rearAccel: 72, rearDecel: 45 },
  brakes: { balance: 54, pressure: 95 },
};

function cdnTune(id: string, name: string) {
  return {
    id,
    gameId: "fm-2023",
    carOrdinal: 2860,
    trackOrdinal: null,
    name,
    author: "someone",
    category: "circuit",
    description: "desc",
    sourceName: "Community",
    settings: SETTINGS,
  };
}

/** Install a fetch stub keyed by URL substring. */
function stubFetch(routes: Record<string, { ok: boolean; body?: unknown }>) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [needle, res] of Object.entries(routes)) {
      if (url.includes(needle)) {
        return {
          ok: res.ok,
          status: res.ok ? 200 : 500,
          json: async () => res.body,
        } as Response;
      }
    }
    return { ok: false, status: 404, json: async () => ({}) } as Response;
  }) as typeof fetch;
}

const realFetch = globalThis.fetch;
let savedSettings: string | null = null;

beforeEach(async () => {
  await db.delete(communityTunes).run();
  savedSettings = existsSync(SETTINGS_PATH) ? readFileSync(SETTINGS_PATH, "utf-8") : null;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  if (savedSettings !== null) writeFileSync(SETTINGS_PATH, savedSettings);
});

describe("replaceCommunityTunes", () => {
  test("replace-all swaps the full set for a game", async () => {
    await replaceCommunityTunes("fm-2023", [
      {
        id: "community-1",
        gameId: "fm-2023",
        carOrdinal: 2860,
        trackOrdinal: null,
        name: "A",
        author: "x",
        category: "circuit",
        description: "",
        sourceName: "Community",
        settings: JSON.stringify(SETTINGS),
      },
    ]);
    expect((await getCommunityTunes("fm-2023")).length).toBe(1);

    await replaceCommunityTunes("fm-2023", [
      {
        id: "community-2",
        gameId: "fm-2023",
        carOrdinal: 2860,
        trackOrdinal: null,
        name: "B",
        author: "x",
        category: "circuit",
        description: "",
        sourceName: "Community",
        settings: JSON.stringify(SETTINGS),
      },
    ]);
    const rows = await getCommunityTunes("fm-2023");
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("community-2");
    expect(await getCommunityTuneById("community-1")).toBeNull();
  });
});

describe("syncCommunityTunes", () => {
  test("skips work when manifest version matches stored version", async () => {
    setCommunityTunesSyncState("v1");
    let tunesFetched = false;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("tunes.json")) tunesFetched = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: "v1", games: { "fm-2023": { path: "fm-2023/tunes.json" } } }),
      } as Response;
    }) as typeof fetch;

    const result = await syncCommunityTunes();
    expect(result.synced).toBe(false);
    expect(tunesFetched).toBe(false);
  });

  test("replaces rows when version changes", async () => {
    setCommunityTunesSyncState("old");
    stubFetch({
      "manifest.json": { ok: true, body: { version: "v2", games: { "fm-2023": { path: "fm-2023/tunes.json" } } } },
      "tunes.json": { ok: true, body: [cdnTune("community-a", "Alpha"), cdnTune("community-b", "Bravo")] },
    });

    const result = await syncCommunityTunes();
    expect(result.synced).toBe(true);
    expect(result.count).toBe(2);
    expect(result.version).toBe("v2");
    expect((await getCommunityTunes("fm-2023")).length).toBe(2);
  });

  test("skips invalid rows but keeps valid ones", async () => {
    setCommunityTunesSyncState("old");
    stubFetch({
      "manifest.json": { ok: true, body: { version: "v3", games: { "fm-2023": { path: "fm-2023/tunes.json" } } } },
      "tunes.json": { ok: true, body: [cdnTune("community-a", "Alpha"), { id: "bad" }] },
    });

    const result = await syncCommunityTunes();
    expect(result.synced).toBe(true);
    expect(result.count).toBe(1);
  });

  test("tunes fetch failure keeps existing cache", async () => {
    await replaceCommunityTunes("fm-2023", [
      {
        id: "community-existing",
        gameId: "fm-2023",
        carOrdinal: 2860,
        trackOrdinal: null,
        name: "Existing",
        author: "x",
        category: "circuit",
        description: "",
        sourceName: "Community",
        settings: JSON.stringify(SETTINGS),
      },
    ]);
    setCommunityTunesSyncState("v0");
    stubFetch({
      "manifest.json": { ok: true, body: { version: "v9", games: { "fm-2023": { path: "fm-2023/tunes.json" } } } },
      "tunes.json": { ok: false },
    });

    const result = await syncCommunityTunes();
    expect(result.synced).toBe(false);
    const rows = await getCommunityTunes("fm-2023");
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe("community-existing");
  });
});
