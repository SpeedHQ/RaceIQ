import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { zipSync, unzipSync } from "fflate";
import { db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { decodeMotecSourceArchive } from "@raceiq/backend-core/motec/source-archive";
import { deleteSession } from "@raceiq/backend-core/db/session-queries";
import { decompressIfGzipSync, iterateSessionFrames } from "@raceiq/capture-formats/session/framing";
import { SparseSessionRecorder } from "@raceiq/capture-formats/session/sparse-recorder";
import { initServerGameAdapters } from "../../src/games/init";
import { initMotecTargets } from "../../src/games/motec-init";
import { transferRoutes } from "../../src/routes/laps/transfer-routes";
import { stopMaintenanceTasks } from "@raceiq/backend-core/telemetry/live-pipeline";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { registerDriverProfileLapNotifier } from "@raceiq/backend-core/driver-profile/lap-notifier";
const importedSessionIds: number[] = [];
const temporaryDirectories: string[] = [];

const MOTEC_ARCHIVE = "test/artifacts/motec/acc-barcelona-porsche-992.zip";

initGameAdapters();
initServerGameAdapters();
initMotecTargets();
registerDriverProfileLapNotifier(() => {});
afterAll(async () => {
  for (const id of importedSessionIds.splice(0)) await deleteSession(id);
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
  stopMaintenanceTasks();
});

describe("ZIP import ownership validation", () => {
  test.each([
    ["missing", undefined],
    ["invalid", "everyone"],
  ])("rejects %s ownership", async (_label, ownership) => {
    const form = new FormData();
    form.append("file", new File([new Uint8Array()], "laps.zip"));
    if (ownership) form.append("ownership", ownership);
    const response = await transferRoutes.request("/api/laps/import-zip", { method: "POST", body: form });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "ownership must be exactly mine or others" });
  });
});

test("detects MoTeC LD and LDX archive", async () => {
  const form = new FormData();
  form.append("file", new File([readFileSync(MOTEC_ARCHIVE)], "Barcelona-992-MoTeC.zip"));
  const response = await transferRoutes.request("/api/laps/detect-import", { method: "POST", body: form });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    format: "motec",
    supported: true,
    captureCount: 1,
  });
});
test("reports malformed gzip captures as unsupported", async () => {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([0x1f, 0x8b, 0x08])], "broken.bin.gz"));

  const response = await transferRoutes.request("/api/laps/detect-import", {
    method: "POST",
    body: form,
  });

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    format: "bin",
    supported: false,
    message: "Capture is not a valid bounded gzip stream.",
  });
});

test("rejects malformed gzip imports as bad requests", async () => {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([0x1f, 0x8b, 0x08])], "broken.bin.gz"));
  form.append("ownership", "mine");

  const response = await transferRoutes.request("/api/laps/import", {
    method: "POST",
    body: form,
  });

  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: "Failed to read session capture",
  });
});

test.each(["mine", "others"] as const)("imports sparse RaceIQ captures as %s into its ownership folder", async (ownership) => {
  const name = "fm-2023-2026-04-09T21-55-03-186Z.bin.gz";
  const source = decompressIfGzipSync(readFileSync(`test/artifacts/sessions/${name}`));
  const directory = mkdtempSync(join(tmpdir(), "raceiq-sparse-upload-"));
  temporaryDirectories.push(directory);
  const sparsePath = join(directory, "capture.bin");
  const recorder = new SparseSessionRecorder("fm-2023");
  recorder.start(sparsePath);
  recorder.writeMetaFrame();
  for (const frame of iterateSessionFrames(source)) recorder.writeRecord(frame);
  await recorder.stop();
  const existingIds = new Set(
    (await db.select({ id: sessions.id }).from(sessions).all()).map((row) => row.id),
  );
  const form = new FormData();
  form.append("file", new File([readFileSync(sparsePath)], name));
  form.append("ownership", ownership);
  const response = await transferRoutes.request("/api/laps/import", { method: "POST", body: form });
  expect(response.status).toBe(200);
  const result = await response.json() as { ok: boolean; gameId: string; packetCount: number; imported: number };
  expect(result).toMatchObject({ ok: true, gameId: "fm-2023" });
  expect(result.packetCount).toBeGreaterThan(0);
  expect(result.imported).toBeGreaterThan(0);
  const newSessions = (await db.select().from(sessions).all()).filter((session) => !existingIds.has(session.id));
  for (const session of newSessions) {
    expect(session.ownership).toBe(ownership);
    expect(dirname(session.rawFile!)).toBe(join(resolveRecordingDirectory(), "fm-2023", ownership === "others" ? "others" : "own"));
  }
  importedSessionIds.push(
    ...(await db.select({ id: sessions.id }).from(sessions).all())
      .map((row) => row.id)
      .filter((id) => !existingIds.has(id)),
  );
});

test("rejects legacy full-frame recordings", async () => {
  const name = "fm-2023-2026-04-09T21-55-03-186Z.bin.gz";
  const bytes = readFileSync(`test/artifacts/sessions/${name}`);
  const detectForm = new FormData();
  detectForm.append("file", new File([bytes], name));
  const detection = await transferRoutes.request("/api/laps/detect-import", { method: "POST", body: detectForm });
  expect(detection.status).toBe(200);
  expect(await detection.json()).toMatchObject({
    format: "bin",
    supported: false,
    message: "Only sparse RaceIQ captures are supported.",
  });

  const importForm = new FormData();
  importForm.append("file", new File([bytes], name));
  importForm.append("ownership", "mine");
  const response = await transferRoutes.request("/api/laps/import", { method: "POST", body: importForm });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({
    error: `Could not detect a sparse RaceIQ capture from "${name}".`,
  });
});

test("staged MoTeC names are safe display-only basenames", async () => {
  const archive = zipSync({
    ["folder/\u202eevil.ld"]: new Uint8Array([1]),
    ["folder/\nsetup.ldx"]: new Uint8Array([1]),
  });
  const form = new FormData();
  form.append("file", new File([archive], "unsafe.zip"));

  const response = await transferRoutes.request("/api/laps/stage-motec", {
    method: "POST",
    body: form,
  });
  expect(response.status).toBe(200);
  const staged = await response.json() as {
    token: string;
    ldName: string;
    ldxName: string;
  };
  expect(staged).toMatchObject({
    ldName: "_evil.ld",
    ldxName: "_setup.ldx",
  });

  await transferRoutes.request("/api/laps/cancel-motec", {
    method: "POST",
    body: JSON.stringify({ token: staged.token }),
    headers: { "Content-Type": "application/json" },
  });
});

test.each(["mine", "others"] as const)("imports a MoTeC ZIP as %s into its ownership folder", async (ownership) => {
  const form = new FormData();
  form.append(
    "file",
    new File([readFileSync(MOTEC_ARCHIVE)], "Barcelona-992-MoTeC.zip"),
  );
  form.append("gameId", "acc");
  form.append("carId", "33");
  form.append("trackId", "8");
  form.append("ownership", ownership);

  const response = await transferRoutes.request("/api/laps/import-motec", {
    method: "POST",
    body: form,
  });
  expect(response.status).toBe(200);
  const result = await response.json() as { laps: { sessionId: number }[] };
  expect(result).toMatchObject({
    ok: true,
    gameId: "acc",
    imported: 1,
  });
  const session = await db.select().from(sessions).where(eq(sessions.id, result.laps[0]!.sessionId)).get();
  expect(session?.ownership).toBe(ownership);
  expect(dirname(session!.rawFile!)).toBe(join(resolveRecordingDirectory(), "acc", ownership === "others" ? "others" : "own"));
  const source = decodeMotecSourceArchive(readFileSync(session!.rawFile!));
  const uploaded = unzipSync(readFileSync(MOTEC_ARCHIVE));
  const ldEntry = Object.entries(uploaded).find(([name]) => name.endsWith(".ld"))!;
  expect(source.ldBytes).toEqual(Buffer.from(ldEntry[1]));
}, 30_000);
