import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { buildCloudLapImportFixture } from "../fixtures/cloud-lap-import-fixture";
import { CloudLapImportError, createCloudLapImporter, recoverCloudLapImports, validateCloudLapImportUrl } from "@raceiq/backend-core/session-capture/cloud-lap-import";

describe("cloud lap import URL validation", () => {
  test("accepts only the trusted HTTPS import endpoint and a safe lap identifier", () => {
    expect(validateCloudLapImportUrl("https://raceiq.snazzie.space/api/v1/laps/lap_123/import.zip")).toBe("lap_123");
    for (const value of [
      "http://raceiq.snazzie.space/api/v1/laps/lap_123/import.zip",
      "https://raceiq.snazzie.space.evil.test/api/v1/laps/lap_123/import.zip",
      "https://user@raceiq.snazzie.space/api/v1/laps/lap_123/import.zip",
      "https://raceiq.snazzie.space/api/v1/laps/%2Fadmin/import.zip",
      "https://raceiq.snazzie.space/api/v1/laps/lap_123/import.zip?redirect=https://evil.test",
      "https://raceiq.snazzie.space/api/v1/laps/lap_123/import.zip#fragment",
    ]) {
      expect(() => validateCloudLapImportUrl(value)).toThrow(CloudLapImportError);
    }
  });
  test("permits only explicit loopback HTTP test origins", () => {
    expect(() => createCloudLapImporter({ origin: "http://127.0.0.1:4312" })).not.toThrow();
    for (const origin of ["http://example.test", "http://127.0.0.1.evil.test", "https://user@localhost", "https://localhost/path"]) {
      expect(() => createCloudLapImporter({ origin })).toThrow(CloudLapImportError);
    }
  });
});

describe("cloud lap importer SDK transport", () => {
  test("streams local HTTP SDK archive once for concurrent callers and stores metadata/setup", async () => {
    const setup = Buffer.from([0, 1, 255, 2]);
    const fixture = buildCloudLapImportFixture({ setup });
    const previousDataDir = process.env.DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), "raceiq-cloud-import-"));
    process.env.DATA_DIR = dataDir;
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests++;
        if (request.headers.get("authorization") !== "Bearer fixture-token") return new Response(null, { status: 401 });
        return new Response(fixture.bytes, { headers: { "Content-Type": "application/zip" } });
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const lapId = fixture.manifest.lap.id;
    try {
      const importer = createCloudLapImporter({ origin });
      const input = {
        lapId,
        sourceUrl: `${origin}/api/v1/laps/${lapId}/import.zip`,
        accessToken: "fixture-token",
        onState() {},
      };
      const [first, second] = await Promise.all([importer(input), importer(input)]);
      expect(first).toEqual(second);
      expect(requests).toBe(1);
      const saved = await db.select({
        rawFile: sessions.rawFile,
        setupPath: sessions.cloudImportSetupPath,
        setupName: sessions.cloudImportSetupFileName,
        author: sessions.sourceAuthorDisplayName,
        origin: sessions.cloudImportOrigin,
        lapId: sessions.cloudImportLapId,
        totalTimeMs: laps.totalTimeMs,
        sectorTimesMs: laps.sectorTimesMs,
        recordedAt: laps.recordedAt,
        createdAt: laps.createdAt,
        offset: laps.rawByteOffset,
        frameCount: laps.rawFrameCount,
      }).from(sessions).innerJoin(laps, eq(laps.sessionId, sessions.id))
        .where(and(eq(laps.id, first.id), eq(sessions.id, first.sessionId))).get();
      expect(saved).toMatchObject({
        author: "Fixture Driver",
        origin,
        lapId,
        totalTimeMs: 91_234,
        sectorTimesMs: [30_000, 30_500, 30_734],
        recordedAt: "2026-09-01T12:00:00.000Z",
        createdAt: "2026-09-01T13:00:00.000Z",
        frameCount: 1,
        setupName: "fixture.setup",
      });
      expect(await readFile(saved!.rawFile!)).toEqual(fixture.recording);
      expect(await readFile(saved!.setupPath!)).toEqual(setup);
    } finally {
      server.stop(true);
      await db.delete(sessions).where(and(eq(sessions.cloudImportOrigin, origin), eq(sessions.cloudImportLapId, lapId))).run();
      if (previousDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previousDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  test("maps unavailable authentication and rejects mismatched identity and multi-segment archives", async () => {
    const fixture = buildCloudLapImportFixture();
    const previousDataDir = process.env.DATA_DIR;
    const dataDir = await mkdtemp(join(tmpdir(), "raceiq-cloud-import-errors-"));
    process.env.DATA_DIR = dataDir;
    let unauthorized = false;
    let responseBytes = fixture.bytes;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return unauthorized ? new Response(null, { status: 401 }) : new Response(responseBytes);
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const importer = createCloudLapImporter({ origin });
    try {
      const base = { accessToken: "fixture-token", onState() {} };
      unauthorized = true;
      await expect(importer({ ...base, lapId: fixture.manifest.lap.id })).rejects.toMatchObject({ code: "auth_required" });
      unauthorized = false;
      const wrongLapId = `other-${crypto.randomUUID()}`;
      await expect(importer({
        ...base,
        lapId: wrongLapId,
        sourceUrl: `${origin}/api/v1/laps/${wrongLapId}/import.zip`,
      })).rejects.toMatchObject({ code: "lap_id_mismatch" });
      const multiSegment = buildCloudLapImportFixture({ secondSegment: true });
      responseBytes = multiSegment.bytes;
      await expect(importer({
        ...base,
        lapId: multiSegment.manifest.lap.id,
        sourceUrl: `${origin}/api/v1/laps/${multiSegment.manifest.lap.id}/import.zip`,
      })).rejects.toMatchObject({ code: "invalid_recording" });
      expect(await db.select({ id: sessions.id }).from(sessions)
        .where(eq(sessions.cloudImportLapId, multiSegment.manifest.lap.id)).get()).toBeUndefined();
    } finally {
      server.stop(true);
      if (previousDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previousDataDir;
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});

test("recovers interrupted owned publication without deleting unrelated files", async () => {
  const previousDataDir = process.env.DATA_DIR;
  const root = await mkdtemp(join(tmpdir(), "raceiq-cloud-recovery-"));
  process.env.DATA_DIR = root;
  const directory = join(root, "sessions", "fm-2023");
  await mkdir(directory, { recursive: true });
  const id = crypto.randomUUID();
  const temp = join(directory, `.cloud-${id}.bin.gz.part`);
  const final = join(directory, `cloud-${id}.bin.gz`);
  const setupTemp = join(directory, `.cloud-${id}.setup.part`);
  const setupFinal = join(directory, `cloud-${id}.setup`);
  const sentinel = join(root, "unrelated.bin.gz");
  try {
    for (const path of [temp, final, setupTemp, setupFinal, sentinel]) await writeFile(path, "preserved");
    await writeFile(join(root, `.cloud-import-${id}.json`), JSON.stringify({ version: 1, origin: "https://raceiq.snazzie.space", lapId: `interrupted-${id}`, gameId: "fm-2023", temp, final, setupTemp, setupFinal }));
    await writeFile(join(root, `.cloud-import-${crypto.randomUUID()}.json`), JSON.stringify({ version: 1, origin: "https://raceiq.snazzie.space", lapId: `unsafe-${id}`, gameId: "fm-2023", temp: sentinel, final: sentinel, setupTemp: null, setupFinal: null }));
    await recoverCloudLapImports();
    for (const path of [temp, final, setupTemp, setupFinal]) expect(await Bun.file(path).exists()).toBe(false);
    expect(await readFile(sentinel, "utf8")).toBe("preserved");
  } finally {
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});
