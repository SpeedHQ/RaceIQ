import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { laps, sessions } from "@raceiq/backend-core/db/schema";
import { loadSettings, saveSettings } from "@raceiq/backend-core/runtime/config/settings";
import { cleanupOrphanSessionFiles } from "@raceiq/backend-core/session-capture/cleanup";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";
import { buildCloudLapImportFixture } from "../fixtures/cloud-lap-import-fixture";
import { CloudLapImportError,createCloudLapImporter,recoverCloudLapImports,validateCloudLapImportUrl,type CloudLapImportIdentity } from "@raceiq/backend-core/session-capture/cloud-lap-import";
import { getLayoutMigrationStatus } from "@raceiq/backend-core/session-capture/layout-migration";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { serverReleaseFeatures } from "@raceiq/backend-core/runtime/config/release-features";

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
  test("rejects external HTTP, credentialed and non-root test origin overrides",()=>{
    for (const origin of ["http://example.test", "http://127.0.0.1.evil.test", "https://user@localhost", "https://localhost/path"]) {
      expect(() => createCloudLapImporter({ origin })).toThrow(CloudLapImportError);
    }
  });
});

describe("cloud lap importer SDK transport", () => {
  test("streams local HTTP SDK archive once for concurrent callers and stores metadata/setup", async () => {
    initGameAdapters(serverReleaseFeatures);
    const setup = Buffer.from([0, 1, 255, 2]);
    const fixture = buildCloudLapImportFixture({ setup });
    const previousDataDir = process.env.DATA_DIR;
    const previousSettings = loadSettings();
    const dataDir = await mkdtemp(join(tmpdir(), "raceiq-cloud-import-"));
    const recordingRoot = join(dataDir, "custom-recordings");
    let importedSessionId: number | undefined;
    let setupFilePath: string | undefined;
    let currentSetupFilePath: string | undefined;
    saveSettings({ ...previousSettings, recordingDirectory: recordingRoot });
    process.env.DATA_DIR = dataDir;
    let requests = 0;
    let failDownload = false;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests++;
        if (request.headers.get("authorization") !== "Bearer fixture-token") return new Response(null, { status: 401 });
        if (failDownload) return new Response(null, { status: 503 });
        return new Response(fixture.bytes, { headers: { "Content-Type": "application/zip" } });
      },
    });
    const origin = `http://127.0.0.1:${server.port}`;
    const lapId = fixture.manifest.lap.id;
    try {
      const importer = createCloudLapImporter({ origin });
      const selection={lapGuid:fixture.manifest.lap.guid,gameId:fixture.manifest.lap.gameId,trackId:fixture.manifest.lap.trackId,carId:fixture.manifest.lap.carId};
      const verified=new Set<string>();
      const input = {
        lapId,
        sourceUrl: `${origin}/api/v1/laps/${lapId}/import.zip`,
        accessToken: "fixture-token",
        expectedSelection:selection,
        async assertAuthorized(){},
        isAuthorized:()=>true,
        onIdentity(identity:CloudLapImportIdentity){expect(identity).toEqual(selection);},
        onState() {},
      };
      await expect(importer({...input,isAuthorized:()=>false})).rejects.toMatchObject({code:"auth_required"});
      expect(await db.select({id:sessions.id}).from(sessions).where(eq(sessions.cloudImportLapId,lapId)).all()).toEqual([]);
      const requestsBeforeRetry=requests;
      const [first,second]=await Promise.all([
        importer({...input,onIdentity(identity){input.onIdentity(identity);verified.add("first");}}),
        importer({...input,onIdentity(identity){input.onIdentity(identity);verified.add("second");}}),
      ]);
      expect([...verified].sort()).toEqual(["first","second"]);
      importedSessionId = first.sessionId;
      expect(first).toEqual(second);
      expect(requests-requestsBeforeRetry).toBe(1);
      await expect(importer({...input,expectedSelection:{...selection,lapGuid:crypto.randomUUID()}})).rejects.toMatchObject({code:"lap_identity_conflict"});
      await expect(importer({...input,async assertAuthorized(){throw new CloudLapImportError("auth_required",true);}})).rejects.toMatchObject({code:"auth_required"});
      expect(requests-requestsBeforeRetry).toBe(1);
      const saved = await db.select({
        rawFile: sessions.rawFile,
        setupPath: sessions.cloudImportSetupPath,
        setupName: sessions.cloudImportSetupFileName,
        author: sessions.sourceAuthorDisplayName,
        origin: sessions.cloudImportOrigin,
        lapId: sessions.cloudImportLapId,
        ownership:sessions.ownership,
        totalTimeMs: laps.totalTimeMs,
        sectorTimesMs: laps.sectorTimesMs,
        recordedAt: laps.recordedAt,
        createdAt: laps.createdAt,
        offset: laps.rawByteOffset,
        frameCount: laps.rawFrameCount,
        lapGuid:laps.lapGuid,
      }).from(sessions).innerJoin(laps, eq(laps.sessionId, sessions.id))
        .where(and(eq(laps.id, first.id), eq(sessions.id, first.sessionId))).get();
      expect(saved).toMatchObject({
        author: "Fixture Driver",
        origin,
        lapId,
        lapGuid:fixture.manifest.lap.guid,
        ownership:"others",
        totalTimeMs: 91_234,
        sectorTimesMs: [30_000, 30_500, 30_734],
        recordedAt: "2026-09-01T12:00:00.000Z",
        createdAt: "2026-09-01T13:00:00.000Z",
        frameCount: 1,
        setupName: "fixture.setup",
      });
      expect(await readFile(saved!.rawFile!)).toEqual(fixture.recording);
      expect(await readFile(saved!.setupPath!)).toEqual(setup);
      setupFilePath = saved!.setupPath!;
      expect((await getLayoutMigrationStatus()).fileCount).toBe(0);
      await rm(saved!.rawFile!);
      const directory = dirname(saved!.rawFile!);
      await cleanupOrphanSessionFiles();
      expect(await Bun.file(saved!.setupPath!).exists()).toBe(true);
      const beforeFailure = await readdir(directory);
      failDownload = true;
      await expect(importer(input)).rejects.toMatchObject({ code: "download_failed" });
      failDownload = false;
      const unchanged = await db.select({
        rawFile: sessions.rawFile, setupPath: sessions.cloudImportSetupPath, author: sessions.sourceAuthorDisplayName,
        lapId: sessions.cloudImportLapId, lapIdRow: laps.id,
      }).from(sessions).innerJoin(laps, eq(laps.sessionId, sessions.id))
        .where(eq(sessions.id, first.sessionId)).get();
      expect(unchanged).toMatchObject({
        rawFile: saved!.rawFile, setupPath: saved!.setupPath, author: "Fixture Driver", lapId, lapIdRow: first.id,
      });
      expect(await readdir(directory)).toEqual(beforeFailure);
      const reimported = await importer(input);
      expect(reimported).toEqual(first);
      expect(requests - requestsBeforeRetry).toBe(3);
      expect(await db.select({ id: laps.id }).from(laps).where(eq(laps.sessionId, first.sessionId)).all()).toHaveLength(1);
      const currentSetup = await db.select({ setupPath: sessions.cloudImportSetupPath })
        .from(sessions).where(eq(sessions.id, first.sessionId)).get();
      expect(currentSetup?.setupPath).toBeTruthy();
      currentSetupFilePath = currentSetup!.setupPath!;
      expect(currentSetup!.setupPath).not.toBe(saved!.setupPath);
      const orphan = join(directory, `cloud-${crypto.randomUUID()}.setup`);
      await writeFile(orphan, "orphan setup");
      await cleanupOrphanSessionFiles();
      expect(await Bun.file(orphan).exists()).toBe(false);
      expect(await Bun.file(currentSetup!.setupPath!).exists()).toBe(true);
      expect(await Bun.file(saved!.setupPath!).exists()).toBe(false);
    } finally {
      server.stop(true);
      try {
        if (importedSessionId !== undefined) await deleteSession(importedSessionId);
        if (setupFilePath) expect(await Bun.file(setupFilePath).exists()).toBe(false);
        if (currentSetupFilePath) expect(await Bun.file(currentSetupFilePath).exists()).toBe(false);
      } finally {
        saveSettings(previousSettings);
        if (previousDataDir === undefined) delete process.env.DATA_DIR;
        else process.env.DATA_DIR = previousDataDir;
        await rm(dataDir, { recursive: true, force: true });
      }
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
      const base={accessToken:"fixture-token",expectedSelection:null,async assertAuthorized(){},isAuthorized:()=>true,onIdentity(_identity:CloudLapImportIdentity){},onState(){}};
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

test.each(["legacy", "organized"])("recovers interrupted %s publication without deleting unrelated files", async (layout) => {
  const previousDataDir = process.env.DATA_DIR;
  const previousSettings = loadSettings();
  const root = await mkdtemp(join(tmpdir(), "raceiq-cloud-recovery-"));
  process.env.DATA_DIR = root;
  const recordingRoot = join(root, "custom-recordings");
  saveSettings({ ...previousSettings, recordingDirectory: recordingRoot });
  const directory = layout === "organized" ? join(recordingRoot, "fm-2023", "others") : join(recordingRoot, "fm-2023");
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
    saveSettings(previousSettings);
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    await rm(root, { recursive: true, force: true });
  }
});
