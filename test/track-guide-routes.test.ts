import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { initGameAdapters } from "../shared/games/init";
import { initServerGameAdapters } from "../server/games/init";
import { createTrackGuideStore } from "../shared/racing/tracks/guide/data";
import { loadTrackFacts } from "../shared/racing/tracks/storage/meta";
import { createTrackGuideDevRoutes } from "../server/routes/dev/track-guide-routes";
import { getSharedTrackName } from "../server/routes/tracks/support";
import { writeAtomicJson } from "../shared/platform/runtime/atomic-json";

initGameAdapters();
initServerGameAdapters();

const tempDirs: string[] = [];
function tempStore() {
  const directory = mkdtempSync(join(tmpdir(), "raceiq-track-guides-"));
  tempDirs.push(directory);
  return { directory, store: createTrackGuideStore({ guidesDir: directory }) };
}
function sampleGuide(id: string, numbers?: number[]) {
  return {
    id,
    locale: "en" as const,
    character: "Technical guide",
    corners: [{ key: "corner-1", name: "First", numbers, type: "Medium", technique: "Brake steadily", trap: "Late apex" }],
    priorityCorners: ["corner-1"],
  };
}
function knownSelection(): { gameId: "f1-2025"; trackOrdinal: number; slug: string } {
  for (let trackOrdinal = 0; trackOrdinal < 500; trackOrdinal++) {
    const slug = getSharedTrackName(trackOrdinal, "f1-2025");
    if (slug && loadTrackFacts(slug)) return { gameId: "f1-2025", trackOrdinal, slug };
  }
  throw new Error("No seeded F1 track available for guide route test");
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("isolated track guide stores", () => {
  test("keep positive and negative caches isolated and invalidate after save", () => {
    const first = tempStore();
    const second = tempStore();
    expect(first.store.load("spa")).toBeNull();
    expect(second.store.load("spa")).toBeNull();
    writeFileSync(resolve(first.directory, "spa.json"), JSON.stringify(sampleGuide("spa")));
    expect(first.store.load("spa")).toBeNull();
    expect(second.store.load("spa")).toBeNull();
    first.store.invalidate("spa");
    expect(first.store.load("spa")?.id).toBe("spa");
    expect(second.store.load("spa")).toBeNull();
    expect(() => first.store.load("../spa")).toThrow(/Invalid track guide slug/);
  });

  test("loads and saves guide.json beside canonical track metadata", () => {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-track-guides-nested-"));
    tempDirs.push(directory);
    const trackDirectory = resolve(directory, "spa-francorchamps", "tracks", "grand-prix");
    mkdirSync(trackDirectory, { recursive: true });
    writeFileSync(
      resolve(trackDirectory, "metadata.json"),
      JSON.stringify({
        facts: { slug: "spa" },
      }),
    );
    const store = createTrackGuideStore({ guidesDir: directory, nested: true });

    expect(store.list()).toEqual([]);
    expect(store.save(sampleGuide("spa")).id).toBe("spa");
    expect(store.load("spa")?.character).toBe("Technical guide");
    expect(JSON.parse(readFileSync(resolve(trackDirectory, "guide.json"), "utf8")).id).toBe("spa");
  });

  test("atomic writes preserve target when serialization fails", () => {
    const { directory } = tempStore();
    const path = resolve(directory, "spa.json");
    writeAtomicJson(path, sampleGuide("spa"));
    const original = readFileSync(path, "utf8");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => writeAtomicJson(path, circular)).toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readdirSync(directory).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("track guide dev route", () => {
  test("returns exact envelope and saves through injected store", async () => {
    const { store } = tempStore();
    const selection = knownSelection();
    const app = createTrackGuideDevRoutes({ store });
    const query = `?gameId=${selection.gameId}`;
    const initial = await app.request(`/api/dev/track-guides/${selection.trackOrdinal}${query}`);
    expect(initial.status).toBe(200);
    const initialBody = (await initial.json()) as Record<string, unknown>;
    expect(initialBody).toMatchObject({ gameId: selection.gameId, trackOrdinal: selection.trackOrdinal, slug: selection.slug, guide: null, resolved: null });

    const saved = await app.request(`/api/dev/track-guides/${selection.trackOrdinal}${query}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleGuide(selection.slug)),
    });
    expect(saved.status).toBe(200);
    expect((await saved.json()) as Record<string, unknown>).toMatchObject({ slug: selection.slug, guide: { id: selection.slug, locale: "en" } });

    const invalid = await app.request(`/api/dev/track-guides/${selection.trackOrdinal}${query}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleGuide(selection.slug, [Number.MAX_SAFE_INTEGER])),
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ error: expect.stringContaining("unavailable turn") });
    const unchanged = await app.request(`/api/dev/track-guides/${selection.trackOrdinal}${query}`);
    expect((await unchanged.json()) as Record<string, unknown>).toMatchObject({ guide: { character: "Technical guide" } });
  });

  test("rejects identity, shape, priority, and anchor errors without replacing target", async () => {
    const { directory, store } = tempStore();
    const selection = knownSelection();
    const app = createTrackGuideDevRoutes({ store });
    const url = `/api/dev/track-guides/${selection.trackOrdinal}?gameId=${selection.gameId}`;
    const valid = sampleGuide(selection.slug);
    expect(
      (
        await app.request(url, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(valid),
        })
      ).status,
    ).toBe(200);
    const target = resolve(directory, `${selection.slug}.json`);
    const original = readFileSync(target, "utf8");
    const duplicateCorner = { ...valid.corners[0], name: "Duplicate" };
    const invalidBodies: Array<{ label: string; body: unknown; error: string }> = [
      { label: "id", body: { ...valid, id: "wrong-track" }, error: "does not match filename" },
      { label: "locale", body: { ...valid, locale: "fr" }, error: 'locale must be "en"' },
      { label: "key", body: { ...valid, corners: [...valid.corners, duplicateCorner] }, error: "duplicate key" },
      { label: "priority", body: { ...valid, priorityCorners: ["missing"] }, error: "matches no corner key" },
      { label: "anchor", body: sampleGuide(selection.slug, [Number.MAX_SAFE_INTEGER]), error: "unavailable turn" },
    ];

    for (const fixture of invalidBodies) {
      const response = await app.request(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fixture.body),
      });
      expect(response.status, fixture.label).toBe(400);
      expect(((await response.json()) as { error: string }).error, fixture.label).toContain(fixture.error);
      expect(readFileSync(target, "utf8"), fixture.label).toBe(original);
    }
  });

  test("returns missing-slug and write failures with stable statuses", async () => {
    const base = tempStore();
    const missingApp = createTrackGuideDevRoutes({ store: base.store });
    const missing = await missingApp.request("/api/dev/track-guides/999999?gameId=f1-2025");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Track slug not found for selected track" });

    const selection = knownSelection();
    const failingStore = {
      ...base.store,
      save: () => {
        throw new Error("disk full");
      },
    };
    const failingApp = createTrackGuideDevRoutes({ store: failingStore });
    const failed = await failingApp.request(`/api/dev/track-guides/${selection.trackOrdinal}?gameId=${selection.gameId}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sampleGuide(selection.slug)),
    });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "disk full" });
  });
});
