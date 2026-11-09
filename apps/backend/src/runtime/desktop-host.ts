import { isAbsolute } from "node:path";

/** Desktop hosts must own their port and explicitly select writable storage. */
export function readDesktopHostOptions(env: NodeJS.ProcessEnv = process.env): { httpPort: number; hostname: "127.0.0.1" } | null {
  if (env.RACEIQ_DESKTOP !== "1") return null;
  if (!env.DATA_DIR || !isAbsolute(env.DATA_DIR)) throw new Error("Desktop mode requires an absolute DATA_DIR");
  if (env.SERVER_HOST && env.SERVER_HOST !== "127.0.0.1") throw new Error("Desktop HTTP must use IPv4 loopback (127.0.0.1)");
  const value = env.SERVER_PORT ?? "0";
  const httpPort = Number(value);
  if (!/^\d+$/.test(value) || !Number.isInteger(httpPort) || httpPort < 0 || httpPort > 65535) {
    throw new Error("Desktop SERVER_PORT must be an integer from 0 to 65535");
  }
  return { httpPort, hostname: "127.0.0.1" };
}
