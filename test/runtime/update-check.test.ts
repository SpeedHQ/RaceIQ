import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolveDataDir } from "../../server/runtime/config/data-dir";
import { collectReleaseNotes, fetchReleases, getReleaseNotes, isNewer, mergeLatestRelease, shouldFetchReleaseArtifacts } from "../../server/runtime/update/check";
describe("resolveDataDir", () => {
  let originalDataDir: string | undefined;

  beforeEach(() => {
    originalDataDir = process.env.DATA_DIR;
  });

  afterEach(() => {
    if (originalDataDir === undefined) {
      delete process.env.DATA_DIR;
    } else {
      process.env.DATA_DIR = originalDataDir;
    }
  });

  test("returns DATA_DIR env var when set", () => {
    process.env.DATA_DIR = "/custom/path";
    expect(resolveDataDir()).toBe("/custom/path");
  });

  test("throws instead of returning the real user data dir under test", () => {
    delete process.env.DATA_DIR;
    // Safety net: tests wipe tables unconditionally, so handing back the real
    // USER_DATA_DIR would destroy live data. Must fail loudly, not fall back.
    expect(() => resolveDataDir()).toThrow(/refusing to return the real user data dir/);
  });
});

describe("isNewer", () => {
  test("1.2.3 is newer than 1.2.2", () => {
    expect(isNewer("1.2.3", "1.2.2")).toBe(true);
  });

  test("1.3.0 is newer than 1.2.9", () => {
    expect(isNewer("1.3.0", "1.2.9")).toBe(true);
  });

  test("2.0.0 is newer than 1.9.9", () => {
    expect(isNewer("2.0.0", "1.9.9")).toBe(true);
  });

  test("same version is not newer", () => {
    expect(isNewer("1.2.3", "1.2.3")).toBe(false);
  });

  test("older version is not newer", () => {
    expect(isNewer("1.2.1", "1.2.3")).toBe(false);
  });
});

describe("release list merging", () => {
  test("keeps the latest release when the releases list is stale", () => {
    const latest = { tag_name: "v0.14.0", assets: [] };
    const releases = [{ tag_name: "v0.13.0", assets: [] }];

    expect(mergeLatestRelease(releases, latest)).toEqual([latest, ...releases]);
  });

  test("does not duplicate the latest release when the list includes it", () => {
    const latest = { tag_name: "v0.14.0", assets: [] };
    const releases = [latest, { tag_name: "v0.13.0", assets: [] }];

    expect(mergeLatestRelease(releases, latest)).toEqual(releases);
  });
});


describe("release body selection", () => {
  test("uses the GitHub release body instead of release-note assets", () => {
    const release = {
      tag_name: "v0.14.0",
      body: "### Features\n- Faster updates",
      assets: [{ name: "releasenote.md", browser_download_url: "asset" }],
    };

    expect(getReleaseNotes(release)).toBe("### Features\n- Faster updates");
  });
  test("collects bodies from the installed version through latest", () => {
    const releases = [
      { tag_name: "v0.16.0", body: "latest body", published_at: "2026-08-01", assets: [] },
      { tag_name: "v0.15.0", body: "middle body", published_at: "2026-07-01", assets: [] },
      { tag_name: "v0.14.0", body: "installed body", published_at: "2026-06-01", assets: [] },
      { tag_name: "v0.13.0", body: "older body", published_at: "2026-05-01", assets: [] },
    ];

    expect(collectReleaseNotes(releases, "0.14.0")).toEqual({
      newReleases: [
        { version: "0.16.0", notes: "latest body", date: "2026-08-01" },
        { version: "0.15.0", notes: "middle body", date: "2026-07-01" },
      ],
      currentReleaseNotes: "installed body",
      currentReleaseDate: "2026-06-01",
    });
  });
  test("fetches release bodies for every release from the installed version", async () => {
    const originalFetch = globalThis.fetch;
    let requestedUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requestedUrl = String(input);
      return new Response(JSON.stringify([
        { tag_name: "v0.16.0", body: "latest body", published_at: "2026-08-01", assets: [] },
        { tag_name: "v0.15.0", body: "middle body", published_at: "2026-07-01", assets: [] },
        { tag_name: "v0.14.0", body: "installed body", published_at: "2026-06-01", assets: [] },
        { tag_name: "v0.13.0", body: "older body", published_at: "2026-05-01", assets: [] },
      ]), { status: 200 });
    }) as unknown as typeof fetch;

    try {
      const result = await fetchReleases("0.14.0");
      expect(requestedUrl).toBe("https://api.github.com/repos/SpeedHQ/RaceIQ/releases?per_page=50&page=1");
      expect(result.newReleases).toEqual([
        { version: "0.16.0", notes: "latest body", date: "2026-08-01" },
        { version: "0.15.0", notes: "middle body", date: "2026-07-01" },
      ]);
      expect(result.currentReleaseNotes).toBe("installed body");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

});

describe("release artifact cache gate", () => {
  test("does not refetch artifacts when latest tag matches cached tag", () => {
    expect(shouldFetchReleaseArtifacts("0.14.0", "0.14.0")).toBe(false);
  });

  test("fetches artifacts when latest tag changes", () => {
    expect(shouldFetchReleaseArtifacts("0.14.0", "0.15.0")).toBe(true);
  });
});
