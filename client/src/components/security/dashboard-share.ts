import type { AuthStatus } from "@/lib/dashboard-auth";
import { dashboardPort } from "./dashboard-port";

export interface DashboardShareTarget {
  address: string;
  origin: string;
}

export function dashboardShareTargets(status: AuthStatus): DashboardShareTarget[] {
  const port = dashboardPort(status.port);
  const targets = new Map<string, DashboardShareTarget>();

  for (const { address, tailnet } of status.interfaces) {
    if (tailnet) continue;
    const wildcard = address.includes(":") ? "::" : "0.0.0.0";
    if (!status.activeHosts.includes(address) && !status.activeHosts.includes(wildcard)) continue;
    const host = address.includes(":") ? `[${address}]` : address;
    const origin = `http://${host}:${port}`;
    if (!targets.has(origin)) targets.set(origin, { address, origin });
  }

  return [...targets.values()];
}
