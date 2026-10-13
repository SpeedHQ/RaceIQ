import { Hono } from "hono";
import { networkInterfaces } from "node:os";

/** Exclude unusable phone addresses and prefer physical private LAN interfaces. */
export function getLanIPv4Addresses(nics: ReturnType<typeof networkInterfaces>): string[] {
  const candidates: { address: string; rank: number }[] = [];
  for (const [name, entries] of Object.entries(nics)) {
    for (const entry of entries ?? []) {
      if (entry.family !== "IPv4" || entry.internal) continue;
      const octets = entry.address.split(".").map(Number);
      if (octets.length !== 4 || octets.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) continue;
      const [a, b] = octets;
      if (a === 0 || a === 127 || a >= 224 || (a === 169 && b === 254)) continue;
      const privateLan = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
      const virtual = /virtual|vEthernet|vpn|tailscale|zerotier|docker|wsl|vmware|vbox|hyper-v|tun\d*|tap\d*|utun/i.test(name);
      candidates.push({ address: entry.address, rank: (virtual ? 2 : 0) + (privateLan ? 0 : 1) });
    }
  }
  return [...new Set(candidates.sort((a, b) => a.rank - b.rank).map((entry) => entry.address))];
}

export const networkRoutes = new Hono().get("/api/network/info", (c) => {
  const lanIps = getLanIPv4Addresses(networkInterfaces());
  const port = Number(process.env.SERVER_PORT) || 3117;
  return c.json({ lanIps, port });
});
