import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSVM } from "@raceiq/game-lmu-metadata/setups/svm";
import { lmuSetupRoutes } from "../../../src/routes/games/lmu-setups";

const fixture = (wing = 6) => new TextEncoder().encode([
  'VehicleClassSetting="BMW M Hybrid V8 2023 Hypercar"',
  "//VEH=Installed\\Vehicles\\bmw_m_hybrid_v8_2023\\bmw_m_hybrid_v8_2023.veh",
  "[GENERAL]", "Symmetric=1", "[REARWING]", `RWSetting=${wing}//1.4 deg`,
  "[SUSPENSION]", "FrontAntiSwaySetting=2//Connected", "RearAntiSwaySetting=2//Connected",
  "[FRONTLEFT]", "SpringSetting=1//100", "[FRONTRIGHT]", "SpringSetting=2//105",
  "[ENGINE]", "RegenerationMapSetting=0//Fixed", "[DRIVELINE]", "FrontDiffPowerSetting=0//N/A",
  "[UNKNOWN]", "MysterySetting=4//opaque",
].join("\r\n"));

let temp = "";
let oldHome: string | undefined;
let oldExact: string | undefined;
const app = new Hono().route("/", lmuSetupRoutes);
const request = (path: string, init?: RequestInit) => app.request(path, init);

beforeEach(async () => {
  oldHome = process.env.RACEIQ_SETUP_HOME;
  oldExact = process.env.RACEIQ_LMU_SETUP_DIR;
  temp = await mkdtemp(join(tmpdir(), "raceiq-lmu-api-"));
  process.env.RACEIQ_SETUP_HOME = temp;
  delete process.env.RACEIQ_LMU_SETUP_DIR;
  await mkdir(join(temp, "LMU", "UserData", "player", "Settings", "Monza"), { recursive: true });
  await writeFile(join(temp, "LMU", "UserData", "player", "Settings", "Monza", "base.svm"), fixture());
  await writeFile(join(temp, "LMU", "UserData", "player", "Settings", "Monza", "broken.svm"), "not an SVM");
});
afterEach(async () => {
  if (oldHome === undefined) delete process.env.RACEIQ_SETUP_HOME; else process.env.RACEIQ_SETUP_HOME = oldHome;
  if (oldExact === undefined) delete process.env.RACEIQ_LMU_SETUP_DIR; else process.env.RACEIQ_LMU_SETUP_DIR = oldExact;
  await rm(temp, { recursive: true, force: true });
});

const settings = () => join(temp, "LMU", "UserData", "player", "Settings");
const saveBody = (source: unknown, fileName = "changed.svm", edits = [{ id: "REARWING.RWSetting", delta: 1 }]) => ({ source, fileName, edits });

describe("LMU setup file API", () => {
  it("lists only direct files, returns invalid rows and reads raw byte hashes", async () => {
    await mkdir(join(settings(), "Monza", "nested"));
    await writeFile(join(settings(), "Monza", "nested", "hidden.svm"), fixture());
    await writeFile(join(settings(), "root.svm"), fixture());
    const response = await request("/api/lmu/setups");
    expect(response.status).toBe(200);
    const listing = await response.json() as { tracks: { folder: string }[]; files: { path: string; error: string | null; trackFolder: string }[] };
    expect(listing.tracks.map((track) => track.folder)).toContain("Monza");
    expect(listing.files.some((file) => file.path.endsWith("nested/hidden.svm"))).toBe(false);
    expect(listing.files.find((file) => file.path.endsWith("broken.svm"))?.error).toBeTruthy();
    expect(listing.files.find((file) => file.path === "root.svm")?.trackFolder).toBe("");
    const contentResponse = await request("/api/lmu/setup-content?path=Monza%2Fbase.svm");
    const content = await contentResponse.json() as { contentBase64: string; sha256: string };
    expect(contentResponse.status).toBe(200);
    expect(Buffer.from(content.contentBase64, "base64")).toEqual(await readFile(join(settings(), "Monza", "base.svm")));
    expect(content.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects traversal, missing files, invalid files and outside symlinks", async () => {
    expect((await request("/api/lmu/setup-content?path=..%2Foutside.svm")).status).toBe(400);
    expect((await request("/api/lmu/setup-content?path=Monza%2Fmissing.svm")).status).toBe(404);
    expect((await request("/api/lmu/setup-content?path=Monza%2Fbroken.svm")).status).toBe(400);
    const outside = join(temp, "outside.svm");
    await writeFile(outside, fixture());
    try {
      await symlink(outside, join(settings(), "Monza", "escape.svm"), "file");
      const result = await request("/api/lmu/setup-content?path=Monza%2Fescape.svm");
      expect([400, 404]).toContain(result.status);
      const listing = await (await request("/api/lmu/setups")).json() as { files: { path: string }[] };
      expect(listing.files.some((file) => file.path.endsWith("escape.svm"))).toBe(false);
    } catch (error) {
      if (!["EPERM", "EACCES", "ENOTSUP", "EOPNOTSUPP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      console.warn(`LMU file-symlink proof unavailable: ${(error as NodeJS.ErrnoException).code}`);
    }
    if (process.platform === "win32") {
      const outsideDir = join(temp, "outside-directory");
      await mkdir(outsideDir);
      await writeFile(join(outsideDir, "escape.svm"), fixture());
      await symlink(outsideDir, join(settings(), "escape-directory"), "junction");
      expect((await request("/api/lmu/setup-content?path=escape-directory%2Fescape.svm")).status).toBe(400);
      const listing = await (await request("/api/lmu/setups")).json() as { tracks: { folder: string }[] };
      expect(listing.tracks.some((track) => track.folder === "escape-directory")).toBe(false);
    }
    await rm(join(settings(), "Monza", "base.svm"));
    const vanishedSave = await request("/api/lmu/save-setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(saveBody({ kind: "file", path: "Monza/base.svm", sha256: "0".repeat(64) })) });
    expect(vanishedSave.status).toBe(404);
    const gone = await request("/api/lmu/setup-content?path=Monza%2Fbase.svm");
    expect(gone.status).toBe(404);
  });

  it("saves an exact sibling exclusively, preserves source, validates capability locks and stale hashes", async () => {
    const raw = await readFile(join(settings(), "Monza", "base.svm"));
    const original = await (await request("/api/lmu/setup-content?path=Monza%2Fbase.svm")).json() as { sha256: string };
    const response = await request("/api/lmu/save-setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(saveBody({ kind: "file", path: "Monza/base.svm", sha256: original.sha256 })) });
    expect(response.status).toBe(201);
    const saved = await response.json() as { path: string; contentBase64: string };
    expect(saved.path).toBe("Monza/changed.svm");
    expect(await readFile(join(settings(), "Monza", "base.svm"))).toEqual(raw);
    const parsed = parseSVM(Buffer.from(saved.contentBase64, "base64"));
    expect(parsed.ok && parsed.document.settings.get("REARWING.RWSetting")?.index).toBe(7);
    const collision = await request("/api/lmu/save-setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(saveBody({ kind: "file", path: "Monza/base.svm", sha256: original.sha256 })) });
    expect(collision.status).toBe(409);
    const locked = await request("/api/lmu/save-setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(saveBody({ kind: "file", path: "Monza/base.svm", sha256: original.sha256 }, "locked.svm", [{ id: "ENGINE.RegenerationMapSetting", delta: 1 }])) });
    expect(locked.status).toBe(400);
    await writeFile(join(settings(), "Monza", "base.svm"), fixture(5));
    const stale = await request("/api/lmu/save-setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(saveBody({ kind: "file", path: "Monza/base.svm", sha256: original.sha256 }, "stale.svm")) });
    expect(stale.status).toBe(409);
    expect((await stale.json() as { error: string }).error).toContain("Source setup changed");
  });

  it("saves validated uploads into existing track or root, rejects bad names and missing roots", async () => {
    const response = await request("/api/lmu/save-setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(saveBody({ kind: "upload", contentBase64: Buffer.from(fixture()).toString("base64"), trackFolder: "Monza" }, "upload")) });
    expect(response.status).toBe(201);
    expect((await response.json() as { path: string }).path).toBe("Monza/upload.svm");
    const rootUpload = await request("/api/lmu/save-setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(saveBody({ kind: "upload", contentBase64: Buffer.from(fixture()).toString("base64"), trackFolder: "" }, "root-upload")) });
    expect(rootUpload.status).toBe(201);
    expect((await rootUpload.json() as { path: string }).path).toBe("root-upload.svm");
    const absentTrack = await request("/api/lmu/save-setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(saveBody({ kind: "upload", contentBase64: Buffer.from(fixture()).toString("base64"), trackFolder: "MissingTrack" }, "missing")) });
    expect(absentTrack.status).toBe(404);
    const bad = await request("/api/lmu/save-setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(saveBody({ kind: "upload", contentBase64: "###", trackFolder: "Monza" }, "../bad.svm")) });
    expect(bad.status).toBe(400);
    process.env.RACEIQ_SETUP_HOME = join(temp, "missing");
    const missing = await request("/api/lmu/setups");
    expect((await missing.json() as { error: string }).error).toBe("LMU Settings folder not found");
  });
});
