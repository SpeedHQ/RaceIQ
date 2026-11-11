import { describe, expect, test } from "bun:test";
import { readDesktopHostOptions } from "../../src/runtime/desktop-host";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dataDirectory = join(tmpdir(), "RaceIQ Preview");

describe("native desktop backend contract", () => {
  test("standalone launches retain their existing runtime policy", () => {
    expect(readDesktopHostOptions({})).toBeNull();
  });

  test("desktop launches allocate their own HTTP port without overriding configured listeners", () => {
    expect(readDesktopHostOptions({ RACEIQ_DESKTOP: "1", DATA_DIR: dataDirectory }))
      .toEqual({ httpPort: 0, hostname: "127.0.0.1" });
    expect(readDesktopHostOptions({ RACEIQ_DESKTOP: "1", DATA_DIR: dataDirectory, SERVER_PORT: "3217" })?.httpPort).toBe(3217);
    expect(readDesktopHostOptions({ RACEIQ_DESKTOP: "1", DATA_DIR: dataDirectory, SERVER_HOST: "0.0.0.0" })?.hostname).toBe("127.0.0.1");
  });

  test("rejects ambiguous data paths, network exposure and invalid ports before boot", () => {
    const env = { RACEIQ_DESKTOP: "1", DATA_DIR: dataDirectory };
    expect(() => readDesktopHostOptions({ RACEIQ_DESKTOP: "1" })).toThrow("absolute DATA_DIR");
    expect(() => readDesktopHostOptions({ ...env, DATA_DIR: "data" })).toThrow("absolute DATA_DIR");
    for (const port of ["", "abc", "-1", "65536", "3.5"]) {
      expect(() => readDesktopHostOptions({ ...env, SERVER_PORT: port })).toThrow("SERVER_PORT");
    }
  });
});
