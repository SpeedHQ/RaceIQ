import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { strToU8, unzipSync, zipSync } from "fflate";
import { buildSetupBackupArchive, parseSetupBackupArchive, renameSetupBackupArchive } from "../../server/setups/backup-archive";

const manifest = (gameId: "acc" | "ac-evo", setupName: string) => ({ schemaVersion: 1 as const, gameId, carId: "car", trackId: "track", setupName, nativeFormat: gameId === "acc" ? "acc-json" as const : "ac-evo-carsetup" as const, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" });

describe("setup backup archive", () => {
  test("preserves ACC JSON bytes and rename updates only binding fields", () => {
    const payload = Buffer.from('{\n  "carName": "car",\n  "basicSetup": {}\n}\n');
    const archive = buildSetupBackupArchive({ manifest: manifest("acc", "Qualifying"), payload });
    expect(parseSetupBackupArchive(archive).files["Qualifying.json"]).toEqual(payload);
    const renamed = parseSetupBackupArchive(renameSetupBackupArchive(archive, "Race", "2026-01-02T00:00:00.000Z"));
    expect(renamed.files["Race.json"]).toEqual(payload);
    expect(renamed.manifest.carId).toBe("car");
    expect(renamed.manifest.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("preserves AC EVO fixture bytes", () => {
    const payload = readFileSync(resolve(import.meta.dir, "..", "artifacts/carsetup/Default-12312.carsetup"));
    const archive = buildSetupBackupArchive({ manifest: manifest("ac-evo", "Default"), payload });
    expect(parseSetupBackupArchive(archive).files["Default.carsetup"]).toEqual(payload);
  });

  test("rejects traversal and corrupted payloads", () => {
    const payload = Buffer.from('{"carName":"car","basicSetup":{}}');
    const archive = buildSetupBackupArchive({ manifest: manifest("acc", "Safe"), payload });
    const corruptedEntries = unzipSync(archive);
    corruptedEntries["files/Safe.json"]![0] ^= 1;
    const corrupted = Buffer.from(zipSync(corruptedEntries));
    expect(() => parseSetupBackupArchive(corrupted)).toThrow();
  });

  test("rejects extra manifest fields and Windows traversal paths", () => {
    const payload = Buffer.from('{"carName":"car","basicSetup":{}}');
    const archive = buildSetupBackupArchive({ manifest: manifest("acc", "Safe"), payload });
    const original = unzipSync(archive);
    const parsedManifest = JSON.parse(new TextDecoder().decode(original["manifest.json"]!));
    parsedManifest.files[0].extra = true;
    expect(() => parseSetupBackupArchive(Buffer.from(zipSync({
      "manifest.json": strToU8(JSON.stringify(parsedManifest)),
      "files/Safe.json": payload,
    })))).toThrow();

    const traversal = { ...manifest("acc", "Safe"), files: [{ path: "..\\evil.json", size: payload.length, sha256: "x".repeat(64) }] };
    expect(() => parseSetupBackupArchive(Buffer.from(zipSync({
      "manifest.json": strToU8(JSON.stringify(traversal)),
      "files/..\\evil.json": payload,
    })))).toThrow();
  });

  test("rejects invalid rename names", () => {
    const payload = Buffer.from('{"carName":"car","basicSetup":{}}');
    const archive = buildSetupBackupArchive({ manifest: manifest("acc", "Safe"), payload });
    expect(() => renameSetupBackupArchive(archive, "C:relative")).toThrow("invalid setup name");
    expect(() => renameSetupBackupArchive(archive, "Race ")).toThrow("invalid setup name");
  });
});
