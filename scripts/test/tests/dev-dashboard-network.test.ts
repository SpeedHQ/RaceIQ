import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { developmentDashboardHosts } from "../../dev/dashboard-listeners";

describe("development dashboard network access", () => {
  test("uses saved selections and explicit overrides without reading credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-dev-network-"));
    try {
      // libSQL statements can retain native file handles after close() until GC.
      // Process exit releases every handle before the parent removes the fixture.
      const result = spawnSync(process.execPath, [
        join(import.meta.dir, "../fixtures/dev-dashboard-network.ts"),
        join(directory, "app.db"),
      ], { encoding: "utf8", timeout: 15_000, windowsHide: true });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("defaults to loopback and refuses missing loopback or malformed configuration", () => {
    expect(developmentDashboardHosts()).toEqual(["127.0.0.1"]);
    expect(developmentDashboardHosts('["127.0.0.1","127.0.0.2"]')).toEqual(["127.0.0.1", "127.0.0.2"]);
    expect(() => developmentDashboardHosts('["192.0.2.15"]')).toThrow("requires localhost");
    for (const value of ["[]", "null", '["attacker.example"]', "not JSON"]) expect(() => developmentDashboardHosts(value)).toThrow();
  });

  test("serves HTTP and WebSocket upgrades only on selected addresses and releases listeners on stop", async () => {
    // Vite runs in Node. Bun 1.4.2 on Windows crashes in this node:net piping
    // scenario, so exercise the production development runtime in a subprocess.
    const directory = mkdtempSync(join(tmpdir(), "raceiq-dev-listeners-"));
    try {
      const build = await Bun.build({ entrypoints: [join(import.meta.dir, "../fixtures/dev-dashboard-listeners.ts")], target: "node" });
      expect(build.success).toBe(true);
      const script = join(directory, "listeners.mjs");
      writeFileSync(script, await build.outputs[0].text());
      const result = spawnSync("node", [script], { encoding: "utf8", timeout: 15_000, windowsHide: true });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
