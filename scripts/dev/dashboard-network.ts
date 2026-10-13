import Database from "libsql";
import { isIP } from "node:net";

/** Read only listener configuration; never load credentials into Vite. */
export function readDashboardHosts(databasePath: string, override?: string): string[] {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const row = database.prepare("SELECT network_json FROM dashboard_access WHERE id = 1").get() as { network_json: string } | undefined;
    const hosts: unknown = row && JSON.parse(row.network_json)?.hosts;
    if (!Array.isArray(hosts) || hosts.length === 0 || hosts.some((host) => typeof host !== "string" || !isIP(host))) {
      throw new Error("Dashboard listener configuration is missing or corrupt");
    }
    const selected = override ? [override] : hosts as string[];
    if (selected.some((host) => host !== "localhost" && !isIP(host))) throw new Error("Invalid dashboard listener override");
    return selected;
  } finally {
    database.close();
  }
}
