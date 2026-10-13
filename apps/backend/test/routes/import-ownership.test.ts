import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import { initServerGameAdapters } from "../../src/games/init";
import { initMotecTargets } from "../../src/games/motec-init";
import { transferRoutes } from "../../src/routes/laps/transfer-routes";
import { stopMaintenanceTasks } from "@raceiq/backend-core/telemetry/live-pipeline";
import { initGameAdapters } from "@raceiq/game-catalogs/games/init";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@raceiq/backend-core/db/index";
import { sessions } from "@raceiq/backend-core/db/schema";
import { resolveRecordingDirectory } from "@raceiq/backend-core/runtime/config/recording-directory";
import { decodeMotecSourceArchive } from "@raceiq/backend-core/motec/source-archive";

const MOTEC_ARCHIVE = "test/artifacts/motec/acc-barcelona-porsche-992.zip";

initGameAdapters();
initServerGameAdapters();
initMotecTargets();
afterAll(stopMaintenanceTasks);

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

test("rejects unsupported capture storage before importing a bin", async () => {
  const form = new FormData();
  form.append("file", new File([new Uint8Array()], "capture.bin"));
  form.append("ownership", "mine");
  form.append("captureStorage", "unknown");
  const response = await transferRoutes.request("/api/laps/import", { method: "POST", body: form });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "captureStorage must be raw when provided" });
});

test("limits raw capture storage to bin uploads", async () => {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([1])], "capture.duckdb"));
  form.append("ownership", "mine");
  form.append("captureStorage", "raw");
  const response = await transferRoutes.request("/api/laps/import", { method: "POST", body: form });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "Raw capture storage requires a .bin or .bin.gz file" });
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

test.each([
  ["mine", "sparse"],
  ["others", "sparse"],
  ["mine", "raw"],
  ["others", "raw"],
] as const)("imports %s binary telemetry with %s storage into its ownership folder", async (ownership, storage) => {
  const form = new FormData();
  form.append("file", new File([readFileSync("test/artifacts/sessions/fm-2023-2026-04-09T21-55-03-186Z.bin.gz")], "capture.bin.gz"));
  form.append("gameId", "fm-2023");
  form.append("ownership", ownership);
  if (storage === "raw") form.append("captureStorage", "raw");
  const response = await transferRoutes.request("/api/laps/import", { method: "POST", body: form });
  expect(response.status).toBe(200);
  const result = await response.json() as { laps: { sessionId: number }[] };
  const session = await db.select().from(sessions).where(eq(sessions.id, result.laps[0]!.sessionId)).get();
  expect(session?.ownership).toBe(ownership);
  expect(dirname(session!.rawFile!)).toBe(join(resolveRecordingDirectory(), "fm-2023", ownership === "others" ? "others" : "own"));
}, 60_000);
