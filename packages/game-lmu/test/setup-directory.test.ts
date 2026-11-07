import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findLMUSetupsDirectory, parseSteamInstallDir, parseSteamLibraryPaths } from "../src/setup-directory";

const keys = ["RACEIQ_SETUP_HOME", "RACEIQ_LMU_SETUP_DIR"] as const;
const original = new Map(keys.map((key) => [key, process.env[key]]));
afterEach(() => { for (const key of keys) { const value = original.get(key); if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

describe("LMU setup directory discovery", () => {
  it("extracts escaped secondary Steam library paths in numeric order, ignoring comments", () => {
    const paths = parseSteamLibraryPaths('"libraryfolders" { // comment\n "2" { "path" "D:\\\\Games\\\\Steam" } "1" { "path" "C:\\\\Steam" } }');
    expect(paths.map((path) => path.replace(/\\/g, "/"))).toEqual(["C:/Steam", "D:/Games/Steam"]);
  });

  it("rejects malformed install directory paths", () => {
    expect(parseSteamInstallDir('"AppState" { "installdir" "Le Mans Ultimate" }')).toBe("Le Mans Ultimate");
    expect(parseSteamInstallDir('"installdir" "../outside"')).toBeNull();
    expect(parseSteamInstallDir('"installdir" "bad\\\\path"')).toBeNull();
    expect(parseSteamInstallDir('"installdir" ""')).toBeNull();
    expect(parseSteamInstallDir('"AppState" { "installdir" "unterminated"')).toBeNull();
  });

  it("uses exact LMU process root override without fallback", async () => {
    const temp = await mkdtemp(join(tmpdir(), "lmu-discovery-"));
    try {
      const exact = join(temp, "settings");
      await mkdir(exact);
      process.env.RACEIQ_SETUP_HOME = "";
      expect(await findLMUSetupsDirectory()).toBeNull();
      process.env.RACEIQ_SETUP_HOME = join(temp, "missing-home");
      process.env.RACEIQ_LMU_SETUP_DIR = exact;
      expect(await findLMUSetupsDirectory()).toBeNull();
      delete process.env.RACEIQ_SETUP_HOME;
      expect(await findLMUSetupsDirectory()).toBe(exact);
      process.env.RACEIQ_LMU_SETUP_DIR = join(temp, "missing-exact");
      expect(await findLMUSetupsDirectory()).toBeNull();
    } finally { await rm(temp, { recursive: true, force: true }); }
  });

  it("resolves isolated setup home and does not consult real Steam when absent", async () => {
    const temp = await mkdtemp(join(tmpdir(), "lmu-isolated-"));
    try {
      const settings = join(temp, "LMU", "UserData", "player", "Settings");
      process.env.RACEIQ_SETUP_HOME = temp;
      process.env.RACEIQ_LMU_SETUP_DIR = join(temp, "other");
      expect(await findLMUSetupsDirectory()).toBeNull();
      await mkdir(settings, { recursive: true });
      expect(await findLMUSetupsDirectory()).toBe(settings);
    } finally { await rm(temp, { recursive: true, force: true }); }
  });
});
