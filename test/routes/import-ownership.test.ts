import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { initServerGameAdapters } from "../../server/games/init";
import { initMotecTargets } from "../../server/motec/targets";
import { transferRoutes } from "../../server/routes/laps/transfer-routes";
import { stopMaintenanceTasks } from "../../server/telemetry/live-pipeline";
import { initGameAdapters } from "../../shared/games/init";

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

test("imports a MoTeC ZIP directly without staging", async () => {
  const form = new FormData();
  form.append(
    "file",
    new File([readFileSync(MOTEC_ARCHIVE)], "Barcelona-992-MoTeC.zip"),
  );
  form.append("gameId", "acc");
  form.append("carOrdinal", "33");
  form.append("trackOrdinal", "8");
  form.append("ownership", "mine");

  const response = await transferRoutes.request("/api/laps/import-motec", {
    method: "POST",
    body: form,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    gameId: "acc",
    imported: 1,
  });
}, 30_000);
