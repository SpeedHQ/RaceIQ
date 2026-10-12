import { describe, expect, test } from "bun:test";
import Database from "libsql";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDashboardHosts } from "../../dev/dashboard-network";
import { developmentDashboardHosts } from "../../dev/dashboard-listeners";

describe("development dashboard network access", () => {
  test("uses saved selections and explicit overrides without reading credentials", async () => {
    const directory = mkdtempSync(join(tmpdir(), "raceiq-dev-network-"));
    const path = join(directory, "app.db");
    const database = new Database(path);
    try {
      database.exec("CREATE TABLE dashboard_access (id INTEGER PRIMARY KEY, network_json TEXT)");
      database.prepare("INSERT INTO dashboard_access VALUES (1, ?)").run(JSON.stringify({ hosts: ["127.0.0.1", "127.0.0.2"], origins: [] }));
      expect(readDashboardHosts(path)).toEqual(["127.0.0.1", "127.0.0.2"]);
      expect(readDashboardHosts(path, "127.0.0.1")).toEqual(["127.0.0.1"]);
      database.exec("DELETE FROM dashboard_access");
      expect(() => readDashboardHosts(path)).toThrow("missing or corrupt");
      expect(() => readDashboardHosts(join(directory, "absent.db"))).toThrow();
    } finally {
      database.close();
      // Windows can retain SQLite file handles briefly after the connection closes.
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
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
