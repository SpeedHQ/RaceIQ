import { createConnection, createServer, isIP, type Server, type Socket } from "node:net";
import { networkInterfaces } from "node:os";

export function developmentDashboardHosts(value?: string): string[] {
  const hosts: unknown = value ? JSON.parse(value) : ["127.0.0.1"];
  if (!Array.isArray(hosts) || hosts.length === 0 || hosts.some((host) => typeof host !== "string" || (host !== "localhost" && !isIP(host)))) {
    throw new Error("Invalid development dashboard listener configuration");
  }
  if (!hosts.some((host) => ["127.0.0.1", "localhost", "0.0.0.0", "::"].includes(host))) {
    throw new Error("Portless development requires localhost to be selected in Access & security. Enable localhost and restart, or use a production build.");
  }
  return [...new Set(hosts as string[])];
}

/** Additional listeners forward HTTP and WebSocket bytes to loopback Vite. */
export async function startDashboardListeners(port: number, hosts: string[]): Promise<() => Promise<void>> {
  const addresses = new Set<string>();
  for (const host of developmentDashboardHosts(JSON.stringify(hosts))) {
    if (host === "0.0.0.0" || host === "::") {
      // Preserve intentional wildcard access using concrete current addresses,
      // without competing with Vite's loopback socket on the same port.
      for (const values of Object.values(networkInterfaces())) {
        for (const value of values ?? []) {
          if (host === "::" || value.family === "IPv4") addresses.add(value.address);
        }
      }
    } else addresses.add(host === "localhost" ? "127.0.0.1" : host);
  }
  addresses.delete("127.0.0.1");
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  const stop = async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  };
  try {
    for (const host of addresses) {
      const server = createServer((incoming) => {
        const upstream = createConnection({ host: "127.0.0.1", port });
        for (const socket of [incoming, upstream]) {
          sockets.add(socket);
          socket.on("close", () => { sockets.delete(socket); incoming.destroy(); upstream.destroy(); });
          socket.on("error", () => { incoming.destroy(); upstream.destroy(); });
        }
        incoming.pipe(upstream).pipe(incoming);
      });
      servers.push(server);
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host, port, ipv6Only: host.includes(":") }, () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
    }
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}
