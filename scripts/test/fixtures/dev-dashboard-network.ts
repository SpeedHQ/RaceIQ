import assert from "node:assert/strict";
import Database from "libsql";
import { dirname, join } from "node:path";
import { readDashboardHosts } from "../../dev/dashboard-network";

const path = process.argv[2];
assert(path, "Expected a database fixture path");
const database = new Database(path);
try {
  database.exec("CREATE TABLE dashboard_access (id INTEGER PRIMARY KEY, network_json TEXT)");
  database.prepare("INSERT INTO dashboard_access VALUES (1, ?)").run(JSON.stringify({ hosts: ["127.0.0.1", "127.0.0.2"], origins: [] }));
  assert.deepEqual(readDashboardHosts(path), ["127.0.0.1", "127.0.0.2"]);
  assert.deepEqual(readDashboardHosts(path, "127.0.0.1"), ["127.0.0.1"]);
  database.exec("DELETE FROM dashboard_access");
  assert.throws(() => readDashboardHosts(path), /missing or corrupt/);
  assert.throws(() => readDashboardHosts(join(dirname(path), "absent.db")));
} finally {
  database.close();
}
